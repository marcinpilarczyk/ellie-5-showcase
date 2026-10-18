import fs from 'node:fs';
import https from 'node:https';

const d1 = `%%{init: {'theme': 'base', 'themeVariables': { 'primaryColor': '#E8F0FE', 'primaryTextColor': '#174EA6', 'primaryBorderColor': '#1A73E8', 'lineColor': '#1A73E8', 'secondaryColor': '#E6F4EA', 'tertiaryColor': '#FEF7E0' }}}%%
flowchart TD
    subgraph Triggers["Inbound Triggers & Wake"]
        Slack["Slack Events & Interactions"]
        WebUI["Web Control Plane & Spaces"]
        Wake["15-Min Wake Timer"]
        RemLoop["60s Reminder Loop"]
    end

    subgraph Core["Runtime Core & Coworker"]
        Coworker["SlackCoworkerService"]
        Sentinels["Sentinels & Routines"]
        Runner["UnifiedAgentRunner"]
        Router["ModelRouter: Gemini Flash / Reasoning"]
        Dispatcher["ToolDispatcher"]
        Executor["Approval Executor"]
    end

    subgraph Guards["Governance & Verification"]
        Claims["ClaimsBank & Identity Guard"]
        Humanizer["Humanizer Scanners"]
    end

    subgraph Storage["Local State & Spaces"]
        LedgerDB[("Action Ledger DB")]
        AppDB[("Operational App DB")]
        SpacesFS["Self-Hosted Spaces"]
    end

    subgraph External["External Services & Integrations"]
        Google["Google Workspace"]
        Mail["Proton Mail Bridge"]
        DocEngines["DOCX & Chromium Engines"]
        WebMCP["Web Search & MCP Gateway"]
    end

    Slack --> Coworker
    WebUI --> Executor
    Wake --> Sentinels
    RemLoop --> Sentinels
    Coworker --> Runner
    Sentinels --> Runner
    Runner --> Router
    Runner --> Dispatcher
    Dispatcher --> Claims
    Claims --> Humanizer
    Dispatcher --> LedgerDB
    Dispatcher --> AppDB
    Dispatcher --> SpacesFS
    Dispatcher --> DocEngines
    Dispatcher --> External
    Executor --> LedgerDB
    Executor --> External`;

const d2 = `%%{init: {'theme': 'base', 'themeVariables': { 'primaryColor': '#E8F0FE', 'primaryTextColor': '#174EA6', 'primaryBorderColor': '#1A73E8', 'lineColor': '#1A73E8', 'actorBkg': '#E8F0FE', 'actorBorder': '#1A73E8', 'actorTextColor': '#174EA6' }}}%%
sequenceDiagram
    autonumber
    participant Model as Gemini Model
    participant Disp as ToolDispatcher
    participant Guard as ClaimsBank & Humanizer
    participant Ledger as ActionLedger
    participant Ext as External Provider
    participant Exec as Human Approval

    Model->>Disp: Tool Call (gmail_send / document_render)
    Disp->>Disp: Validate ToolGrant & C&C Guard
    alt Content contains owner text
        Disp->>Guard: Verify claims, figures & identity
        Guard->>Guard: Run prose humanizer scanners
    end
    alt EffectClass == CONSEQUENTIAL
        Disp->>Ledger: Stage proposal in Action Ledger
        Disp-->>Model: Return STAGED + Slack Approval Card
        Exec->>Ledger: Human clicks [Approve & Execute]
        Exec->>Ext: Execute external API write
        Exec->>Ledger: Mark VERIFIED / PROVIDER_CONFIRMED
    else EffectClass == INTERNAL_REVERSIBLE_WRITE
        Disp->>Ext: Execute write immediately
        Disp->>Ext: Run Read-Back verify pass
        Disp-->>Model: Return verified result
    end`;

async function download(chart, file) {
  const enc = Buffer.from(chart).toString('base64url');
  const url = 'https://mermaid.ink/img/' + enc;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed with status ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        fs.writeFileSync(file, Buffer.concat(chunks));
        console.log(`Saved ${file} (${Buffer.concat(chunks).length} bytes)`);
        resolve();
      });
    }).on('error', reject);
  });
}

await download(d1, 'docs/diagram1.png');
await download(d2, 'docs/diagram2.png');
