"""
create_kb_connection.py — creates the project connection that the Foundry IQ
knowledge base MCP tool actually requires.

Per Microsoft's guide (Connect a Foundry IQ knowledge base to Foundry Agent
Service), this must be a `RemoteTool` connection with `ProjectManagedIdentity`
auth targeting the KB's MCP endpoint — NOT a generic Azure AI Search
connection with an API key.

Prereqs (do these in the portal first):
  1. Foundry project has a system-assigned managed identity (Azure portal ->
     the project resource -> Identity -> System assigned -> On).
  2. That identity has the "Search Index Data Reader" role on the search
     service (search service -> Access control (IAM) -> Add role assignment).
  3. You are logged in: az login

Env vars (.env supported):
  PROJECT_RESOURCE_ID       ARM ID of the Foundry project. Find it: Azure
                            portal -> the project resource -> Overview ->
                            JSON View -> "id". Copy it exactly.
  SEARCH_ENDPOINT           e.g. https://saharaaisearch.search.windows.net
  KB_NAME                   e.g. sahara-law-kb
  KB_CONNECTION_NAME        name for the new connection (default: sahara-kb-mcp)

Run:
  pip install requests azure-identity python-dotenv
  python agent/create_kb_connection.py

Then set PROJECT_CONNECTION_NAME=<KB_CONNECTION_NAME> in .env and re-run
setup_agent.py.
"""

import os

import requests
from azure.identity import DefaultAzureCredential, get_bearer_token_provider

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

PROJECT_RESOURCE_ID = os.environ["PROJECT_RESOURCE_ID"].strip()
# Ensure the ARM resource id begins with a leading slash so URL joining
# with https://management.azure.com doesn't accidentally merge into
# the hostname (producing management.azure.comsubscriptions...).
if not PROJECT_RESOURCE_ID.startswith("/"):
    PROJECT_RESOURCE_ID = "/" + PROJECT_RESOURCE_ID
SEARCH_ENDPOINT = os.environ["SEARCH_ENDPOINT"].rstrip("/")
KB_NAME = os.environ["KB_NAME"]
CONNECTION_NAME = os.environ.get("KB_CONNECTION_NAME", "sahara-kb-mcp")

MCP_ENDPOINT = (
    f"{SEARCH_ENDPOINT}/knowledgebases/{KB_NAME}/mcp"
    "?api-version=2026-05-01-preview"
)

credential = DefaultAzureCredential()
bearer_token_provider = get_bearer_token_provider(
    credential, "https://management.azure.com/.default"
)
headers = {"Authorization": f"Bearer {bearer_token_provider()}"}

response = requests.put(
    f"https://management.azure.com{PROJECT_RESOURCE_ID}"
    f"/connections/{CONNECTION_NAME}?api-version=2025-10-01-preview",
    headers=headers,
    json={
        "name": CONNECTION_NAME,
        "type": "Microsoft.MachineLearningServices/workspaces/connections",
        "properties": {
            "authType": "ProjectManagedIdentity",
            "category": "RemoteTool",
            "target": MCP_ENDPOINT,
            "isSharedToAll": True,
            "audience": "https://search.azure.com/",
            "metadata": {"ApiType": "Azure"},
        },
    },
)

if not response.ok:
    print(f"FAILED ({response.status_code}): {response.text}")
    response.raise_for_status()

print(f"Connection '{CONNECTION_NAME}' created/updated successfully.")
print(f"Target MCP endpoint: {MCP_ENDPOINT}")
print(f"\nNext: set PROJECT_CONNECTION_NAME={CONNECTION_NAME} in .env and re-run setup_agent.py")