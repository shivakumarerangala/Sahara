"""
server.py — thin FastAPI proxy between the Sahara frontend and the Foundry agent.

The browser never holds Azure credentials; this proxy authenticates with
DefaultAzureCredential and invokes the agent through the project's OpenAI-
compatible Responses API with an agent_reference.

Run:
  pip install fastapi uvicorn azure-ai-projects azure-identity openai
  export PROJECT_ENDPOINT="https://<resource>.services.ai.azure.com/api/projects/<project>"
  export AGENT_NAME="sahara-agent"
  uvicorn server:app --reload --port 8000
"""

import json
import os

from azure.ai.projects import AIProjectClient
from azure.identity import DefaultAzureCredential
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

PROJECT_ENDPOINT = os.environ["PROJECT_ENDPOINT"]
AGENT_NAME = os.environ.get("AGENT_NAME", "sahara-agent")

project = AIProjectClient(
    endpoint=PROJECT_ENDPOINT, credential=DefaultAzureCredential()
)
openai_client = project.get_openai_client()

app = FastAPI(title="Sahara proxy")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten to your frontend origin in production
    allow_methods=["POST"],
    allow_headers=["*"],
)


class Incident(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    language: str = Field(default="English")


FALLBACK = {
    "acknowledgment": (
        "Thank you for telling me. What happened to you is not okay, and it "
        "is not your fault."
    ),
    "risk_level": "moderate",
    "risk_note": "I couldn't complete a full assessment just now.",
    "urgent": False,
    "rights": [],
    "steps": [
        "Please call the 181 Women Helpline (24x7, free) — they can guide you "
        "in your language and connect you to the nearest One Stop Centre.",
        "If you are in immediate danger, call 112.",
    ],
}


@app.post("/api/incident")
def handle_incident(incident: Incident):
    try:
        response = openai_client.responses.create(
            input=json.dumps(
                {"language": incident.language, "incident": incident.text}
            ),
            extra_body={
                "agent_reference": {"name": AGENT_NAME, "type": "agent_reference"}
            },
        )
        raw = (response.output_text or "").replace("```json", "").replace("```", "").strip()
        parsed = json.loads(raw)
        # Minimal shape guarantee so the frontend never breaks
        for key, default in FALLBACK.items():
            parsed.setdefault(key, default)
        return parsed
    except json.JSONDecodeError:
        # Agent replied in prose (e.g. "I don't know") — safe fallback
        return FALLBACK
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Agent unavailable: {exc}")


@app.get("/healthz")
def healthz():
    return {"ok": True, "agent": AGENT_NAME}
