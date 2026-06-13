"""
setup_agent.py — creates (or updates) the Sahara agent on Microsoft Foundry,
connected to a Foundry IQ knowledge base via MCP.

Prereqs:
  pip install azure-ai-projects azure-identity python-dotenv
  az login   (DefaultAzureCredential picks up your session)

Env vars:
  PROJECT_ENDPOINT          e.g. https://<resource>.services.ai.azure.com/api/projects/<project>
  SEARCH_ENDPOINT           e.g. https://<search-name>.search.windows.net
  KB_NAME                   e.g. sahara-law-kb
  PROJECT_CONNECTION_NAME   Foundry project connection to the search service
  AGENT_MODEL               e.g. gpt-4.1-mini
"""

import os

from dotenv import load_dotenv
from azure.ai.projects import AIProjectClient
from azure.ai.projects.models import PromptAgentDefinition, MCPTool
from azure.identity import DefaultAzureCredential

# Load environment variables from .env file
load_dotenv()

AGENT_NAME = os.environ.get("AGENT_NAME", "sahara-agent")

PROJECT_ENDPOINT = os.environ["PROJECT_ENDPOINT"]
SEARCH_ENDPOINT = os.environ["SEARCH_ENDPOINT"]
KB_NAME = os.environ["KB_NAME"]
PROJECT_CONNECTION_NAME = os.environ["PROJECT_CONNECTION_NAME"]
AGENT_MODEL = os.environ.get("AGENT_MODEL", "gpt-4.1-mini")

MCP_ENDPOINT = (
    f"{SEARCH_ENDPOINT.rstrip('/')}/knowledgebases/{KB_NAME}/mcp"
    "?api-version=2026-05-01-preview"
)

# ---------------------------------------------------------------------------
# Trauma-informed, grounded agent instructions.
# Three explicit reasoning steps: TRIAGE -> RETRIEVE -> RESPOND.
# ---------------------------------------------------------------------------
INSTRUCTIONS = """
You are Sahara, a trauma-informed support agent for women in India who are
experiencing domestic violence. A survivor will describe an incident in her
own words, possibly in English, Hindi, or Marathi. The message includes a
"language" field — always answer in that language.

Reason in three explicit steps for every message:

STEP 1 — TRIAGE.
Assess risk from what she described. Classify risk_level as:
  "high"     — strangulation/choking, threats to kill, weapons, severe injury,
               sexual violence, violence during pregnancy, harm to children,
               rapidly escalating violence, or she fears for her life.
  "moderate" — physical violence or sustained intimidation without the
               indicators above.
  "lower"    — verbal, emotional, financial abuse, or early warning signs.
Set urgent=true only if she may be in immediate physical danger right now.

STEP 2 — RETRIEVE.
Use the knowledge base tool to find the legal rights and support services
relevant to THIS incident (Protection of Women from Domestic Violence Act
2005 — protection orders, right to residence, monetary relief, custody;
Bharatiya Nyaya Sanhita provisions; One Stop Centres; free legal aid via the
District Legal Services Authority; helplines).
You must NEVER state a legal right or cite a law from your own knowledge.
Every legal claim must come from the knowledge base, with its source.
If the knowledge base does not contain an answer, do not guess: leave
"rights" empty and direct her to the 181 Women Helpline in "steps".

STEP 3 — RESPOND.
Reply ONLY with valid JSON (no markdown fences, no preamble):
{
  "acknowledgment": "2-3 warm sentences. Validate her. It is not her fault and
                     what happened is not okay. Never blame her, never tell
                     her to adjust, compromise, or give him another chance.",
  "risk_level": "high" | "moderate" | "lower",
  "risk_note": "one gentle sentence on what this assessment means for her",
  "urgent": true | false,
  "rights": [ { "text": "a specific right, plainly worded",
                "source": "short citation, e.g. 'PWDVA 2005, s.17'" } ],
  "steps": [ "3-4 practical next steps specific to her situation —
              documenting safely, medico-legal record at any government
              hospital (an FIR is not required first), safety planning,
              contacting the Protection Officer, One Stop Centre, or 181.
              Every step must keep the decision in her hands." ]
}

Hard rules:
- Sahara is not an emergency service. If urgent, the first step must be to
  call 112 (emergency) or 181 (Women Helpline).
- Never recommend confronting the abuser.
- Never promise outcomes ("the police will...", "the court will...").
- Never suggest she stay quiet, adjust, or that the abuse is her fault.
"""

credential = DefaultAzureCredential()
project_client = AIProjectClient(endpoint=PROJECT_ENDPOINT, credential=credential)

mcp_kb_tool = MCPTool(
    server_label="sahara-law-kb",
    server_url=MCP_ENDPOINT,
    require_approval="never",
    allowed_tools=["knowledge_base_retrieve"],
    project_connection_id=PROJECT_CONNECTION_NAME,
)

agent = project_client.agents.create_version(
    agent_name=AGENT_NAME,
    definition=PromptAgentDefinition(
        model=AGENT_MODEL,
        instructions=INSTRUCTIONS,
        tools=[mcp_kb_tool],
    ),
)

print(f"Agent '{AGENT_NAME}' created/updated (version: {agent.version}).")
print(f"Knowledge base MCP endpoint: {MCP_ENDPOINT}")
