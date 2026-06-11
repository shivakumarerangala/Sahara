"""
whatsapp_bot.py — WhatsApp channel for the Sahara agent.

Uses Meta's WhatsApp Business Cloud API. Incoming messages hit the /webhook
endpoint, get routed to the same Sahara agent on Microsoft Foundry (via the
logic in server.py), and the structured response is formatted as a WhatsApp
reply.

Setup (Meta for Developers):
  1. Create a Meta app -> add the WhatsApp product (test number works for demo).
  2. Set the webhook URL to https://<your-host>/webhook and subscribe to
     the "messages" field. Use VERIFY_TOKEN below for verification.
  3. Put the permanent access token and phone number ID in env vars.

Run:
  pip install fastapi uvicorn httpx azure-ai-projects azure-identity openai
  export PROJECT_ENDPOINT="https://<resource>.services.ai.azure.com/api/projects/<project>"
  export AGENT_NAME="sahara-agent"
  export WHATSAPP_TOKEN="<meta permanent access token>"
  export WHATSAPP_PHONE_ID="<phone number id>"
  export WHATSAPP_VERIFY_TOKEN="<any random string, same as in Meta console>"
  uvicorn whatsapp_bot:app --port 8001

Safety design notes:
  - Privacy first: incident text is NOT persisted by this bot, and phone
    numbers are never logged. The evidence-journal feature stays in the app,
    where storage is deliberate and deletable; on WhatsApp the safest default
    is to keep nothing.
  - The bot never sends unprompted messages. A notification arriving while
    the abuser holds the phone is a real hazard. Reply-only, always.
  - Every reply carries a short safety footer (disappearing messages /
    delete chat). The HELP keyword returns hotline numbers immediately
    without invoking the agent at all.
"""

import json
import os

import httpx
from azure.ai.projects import AIProjectClient
from azure.identity import DefaultAzureCredential
from fastapi import FastAPI, Request, Response

PROJECT_ENDPOINT = os.environ["PROJECT_ENDPOINT"]
AGENT_NAME = os.environ.get("AGENT_NAME", "sahara-agent")
WHATSAPP_TOKEN = os.environ["WHATSAPP_TOKEN"]
WHATSAPP_PHONE_ID = os.environ["WHATSAPP_PHONE_ID"]
VERIFY_TOKEN = os.environ["WHATSAPP_VERIFY_TOKEN"]

GRAPH_URL = f"https://graph.facebook.com/v21.0/{WHATSAPP_PHONE_ID}/messages"

project = AIProjectClient(
    endpoint=PROJECT_ENDPOINT, credential=DefaultAzureCredential()
)
openai_client = project.get_openai_client()

app = FastAPI(title="Sahara WhatsApp channel")

SAFETY_FOOTER = (
    "\n\n_Tip: tap the chat name > Disappearing messages > 24 hours. "
    "You can also delete this chat anytime. "
    "In immediate danger, call *112*._"
)

WELCOME = (
    "Namaste, this is *Sahara* — a private place to be heard. \U0001F33F\n\n"
    "You can tell me, in your own words, about something that happened to "
    "you at home. I will listen, tell you what your rights are under Indian "
    "law, and share safe next steps. I will never message you first, and I "
    "keep nothing you write.\n\n"
    "You can write in English, Hindi, Marathi, or Telugu.\n"
    "Reply *HELP* anytime for helpline numbers."
    + SAFETY_FOOTER
)

HELPLINES = (
    "*Help that is always available*\n"
    "\U0001F6A8 *112* — Emergency (police, ambulance)\n"
    "\U0001F4DE *181* — Women Helpline, 24x7, free, in your language\n"
    "\U0001F46E *1091* — Women Police Helpline\n\n"
    "The 181 helpline can connect you to the nearest One Stop Centre "
    "(Sakhi) — one place for medical, police, legal, and shelter support."
    + SAFETY_FOOTER
)

RISK_LABEL = {"high": "\u26A0\uFE0F Please read this first",
              "moderate": "What this means",
              "lower": "What this means"}


def detect_language(text: str) -> str:
    """Best-effort script detection so the agent answers in her language."""
    for ch in text:
        code = ord(ch)
        if 0x0900 <= code <= 0x097F:
            return "Hindi or Marathi (match the user's wording)"
        if 0x0C00 <= code <= 0x0C7F:
            return "Telugu"
    return "English"


def format_reply(parsed: dict) -> str:
    """Turn the agent's JSON into a single warm WhatsApp message."""
    parts = []
    if parsed.get("urgent"):
        parts.append(
            "\U0001F6A8 *If you are in danger right now, call 112 or 181 "
            "immediately, or go to a neighbour you trust. Your safety comes "
            "first.*\n"
        )
    if parsed.get("acknowledgment"):
        parts.append(parsed["acknowledgment"])
    if parsed.get("risk_note"):
        label = RISK_LABEL.get(parsed.get("risk_level", "lower"), "")
        parts.append(f"\n*{label}*\n{parsed['risk_note']}")
    rights = parsed.get("rights") or []
    if rights:
        lines = ["\n*Your rights*"]
        for r in rights:
            text = r["text"] if isinstance(r, dict) else str(r)
            source = r.get("source") if isinstance(r, dict) else None
            lines.append(f"\u2022 {text}" + (f" _({source})_" if source else ""))
        parts.append("\n".join(lines))
    steps = parsed.get("steps") or []
    if steps:
        parts.append("\n*When you're ready*\n" + "\n".join(f"\u2022 {s}" for s in steps))
    parts.append(SAFETY_FOOTER)
    return "\n".join(parts)


async def send_whatsapp(to: str, body: str) -> None:
    async with httpx.AsyncClient(timeout=30) as client:
        await client.post(
            GRAPH_URL,
            headers={"Authorization": f"Bearer {WHATSAPP_TOKEN}"},
            json={
                "messaging_product": "whatsapp",
                "to": to,
                "type": "text",
                "text": {"body": body[:4000]},
            },
        )


@app.get("/webhook")
def verify(request: Request):
    """Meta webhook verification handshake."""
    params = request.query_params
    if (
        params.get("hub.mode") == "subscribe"
        and params.get("hub.verify_token") == VERIFY_TOKEN
    ):
        return Response(content=params.get("hub.challenge", ""), media_type="text/plain")
    return Response(status_code=403)


@app.post("/webhook")
async def incoming(request: Request):
    payload = await request.json()
    try:
        for entry in payload.get("entry", []):
            for change in entry.get("changes", []):
                for msg in change.get("value", {}).get("messages", []) or []:
                    if msg.get("type") != "text":
                        continue
                    sender = msg["from"]
                    text = msg["text"]["body"].strip()

                    upper = text.upper()
                    if upper in {"HI", "HELLO", "START", "NAMASTE"}:
                        await send_whatsapp(sender, WELCOME)
                        continue
                    if upper == "HELP":
                        await send_whatsapp(sender, HELPLINES)
                        continue

                    # Same Sahara agent as the app — second front door.
                    try:
                        response = openai_client.responses.create(
                            input=json.dumps(
                                {
                                    "language": detect_language(text),
                                    "incident": text,
                                }
                            ),
                            extra_body={
                                "agent_reference": {
                                    "name": AGENT_NAME,
                                    "type": "agent_reference",
                                }
                            },
                        )
                        raw = (response.output_text or "")
                        raw = raw.replace("```json", "").replace("```", "").strip()
                        parsed = json.loads(raw)
                        await send_whatsapp(sender, format_reply(parsed))
                    except Exception:
                        # Safe failure mode: never leave her without a path.
                        await send_whatsapp(
                            sender,
                            "I'm having trouble responding right now, but you "
                            "are not alone. Please call *181* (Women Helpline, "
                            "24x7, free) — they will listen and guide you. In "
                            "immediate danger, call *112*." + SAFETY_FOOTER,
                        )
    except Exception:
        pass  # never 500 back to Meta; webhook retries would duplicate messages
    return {"status": "ok"}
