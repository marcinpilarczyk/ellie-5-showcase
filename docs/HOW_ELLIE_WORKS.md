# How Ellie Works: A Plain-English Guide to an AI Chief of Staff

> **Showcase note:** This document explains the reference implementation. It is not a promise that
> every path is production-ready. Ellie sends task content to external model and integration
> providers; “private” here means single-tenant access, not that data never leaves the host.

> *"The agent owns the work. The owner owns decisions and commitments. Code owns the authority."*

---

## 1. What is Ellie? (In One Minute)

Imagine having a sharp, dedicated executive assistant who works inside your Slack 24 hours a day, 7 days a week.

**Ellie is not a generic chatbot.** You don't have to visit a website, open a blank prompt box, or re-explain who you are every time you need something done. Instead:

* **She lives where you work:** Ellie sits directly in your private Slack channels and threads.
* **She handles real-world tools:** She reads your Gmail and Proton Mail, inspects your Google Calendar, searches and reads your Google Drive files, browses the web, and queries spreadsheets.
* **She produces finished work:** Rather than giving you a rough conversational outline, Ellie produces camera-ready 2-page resumes, formatted cover letters, visual pitch sheets, and interactive web dashboards.
* **She watches your back while you sleep:** She monitors incoming emails, tracks who owes you a reply, prepares morning briefings, and flags schedule conflicts.
* **She never makes commitments without your permission:** Ellie can research, organize, and draft anything—but she cannot hit "send" on an email, accept an invite, or change a public calendar event without your explicit, one-click sign-off.

---

## 2. Why Was Ellie Built? The Problems with Today's AI

If you've ever used ChatGPT, Claude, or commercial AI agent platforms, you've likely encountered three major frustrations:

### Problem 1: The "Dumb Waiting" Problem
Most AI tools are completely passive. They do nothing until you type a prompt. A true executive assistant doesn't wait to be told to check if tomorrow's flights are on time; they check automatically and notify you only if there's a delay.

### Problem 2: The "Credit Meter" Anxiety
Commercial AI agent platforms often charge high monthly fees or drain expensive "credits" every time the assistant checks your inbox or calendar. When checking for new emails costs money every 5 minutes, running continuous 24/7 background watchers becomes unaffordable.

### Problem 3: The "Loose Cannon" Fear (Hallucinations & Accidental Sends)
Large language models are notorious for two things:
1. **Inventing facts** (fabricating past job titles, rounding up metrics, or making up phone numbers).
2. **Accidental actions** (promising things to clients or sending unreviewed emails because of a misunderstanding).

**Ellie was built to reduce all three problems with deterministic controls, explicit approval
flows, and narrow background triggers.**

---

## 3. The Three Golden Rules of Ellie

Everything in Ellie's design follows three fundamental principles:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        THE THREE GOLDEN RULES                          │
├──────────────────────────────┬─────────────────────────────────────────┤
│ 1. Cheap Triggers,           │ Polling is lightweight. The AI brain     │
│    Expensive Thinking        │ wakes up when something actually changes│
├──────────────────────────────┼─────────────────────────────────────────┤
│ 2. The Agent Proposes,       │ Ellie drafts the work; YOU approve the  │
│    The Human Decides         │ action with a single click.             │
├──────────────────────────────┼─────────────────────────────────────────┤
│ 3. Code Holds the Keys,      │ Safety rules are locked in software,    │
│    Not the AI Prompt         │ never left to the AI's "good behavior." │
└──────────────────────────────┴─────────────────────────────────────────┘
```

### Rule 1: Cheap Triggers, Expensive Thinking
Think of motion-sensor lights outside a house. You don't leave high-powered stadium floodlights burning 24/7 just in case someone walks by. The motion sensor costs pennies to run, and the bright lights only turn on when movement is detected.

Ellie operates the same way:
* Checking if you have new unread emails or if a Google Drive document was updated is handled by lightweight host code that does not call a language model.
* The advanced AI models (Google Gemini) are only summoned when a new email arrives or an action needs genuine human-level reasoning.
* **Result:** Polling does not require a model call. Hosting and provider prices still apply.

### Rule 2: The Agent Proposes, The Human Decides
Ellie is strictly forbidden from executing outward-facing commitments on her own. 

If Ellie writes an email reply to an investor or client, she doesn't send it. Instead, she posts an interactive **Approval Card** into your Slack thread showing the exact recipient, subject, and text. You can review it, ask her to tweak the wording, or click **"Approve & Send"**. Only when your finger clicks the button does the email leave your outbox.

### Rule 3: Code Holds the Keys, Not the AI Prompt
In amateur AI setups, developers tell the AI: *"Please do not send emails without asking me."* But AI models can be confused, tricked, or forget their instructions when conversations get long.

In Ellie, safety is enforced by **hard software code (the Action Ledger)**. The software simply refuses to give the AI the capability to send messages directly. Even if the AI tried its best to bypass the rule, the underlying code blocks the attempt and forces it into the approval queue.

---

## 4. A Day in the Life with Ellie

Here is what an ordinary workday looks like with Ellie managing the background:

### 08:00 AM — The Morning Briefing
Before you start work, Ellie's morning routine wakes up. She scans your Google Calendar, checks your unread Gmail and Proton Mail, and inspects your project trackers.
* If nothing urgent happened and your day is clear, she can stay completely silent (no spam).
* If you have an upcoming meeting or pending action items, a clean, formatted briefing appears in your Slack:
  > *"Good morning. You have 2 meetings today: an intro sync at 11:30 AM and a team review at 3:00 PM. A partner replied to your inquiry (draft ready for review). No overdue items."*

### 11:15 AM — Job & Opportunity Evaluation
You come across an interesting job posting or consulting request on LinkedIn. You paste the link into Slack:
> *"Ellie, should I apply for this role?"*

Ellie doesn't just skim the job title:
1. She fetches the full job description.
2. She loads your verified career dossier and achievements from your private Google Docs.
3. She runs a deep multi-criteria analysis: compensation fit, seniority match, required tech stack vs. your proven track record.
4. She replies with an honest 0–100 score, highlighting strengths, red flags, and exact positioning angles.

### 01:30 PM — Automated Document Generation
You decide to apply. In the same Slack thread, you say:
> *"Generate a tailored resume and pitch sheet for this position."*

Within 45 seconds, Ellie:
* Drafts a customized resume matching the company's specific requirements.
* Runs supported claims through the **Claims Bank** heuristics and flags unsupported figures, contact details, and selected title/link patterns.
* Formats it into an executive layout with professional typography (Merriweather & Google Sans Text).
* Converts it into both a Microsoft Word `.docx` file and a pixel-perfect 2-page PDF.
* Verifies that the PDF is exactly 2 pages (no awkward overflow lines on page 3) and readable by automated recruiting software (ATS).
* Uploads both files to your Google Drive and shares direct links in Slack.

### 03:45 PM — Inbound Email Triage & Follow-Through
A potential client emails you asking about your availability next week.
* Ellie detects the new email within minutes.
* She cross-references your calendar, sees that you are open on Tuesday and Thursday afternoon, and drafts a friendly, professional response.
* She posts a Slack card with the proposed reply.
* You tap **"Approve"**. The email is sent through your actual Gmail account, and Ellie automatically logs a reminder to follow up if they haven't replied in 4 business days.

---

## 5. Ellie's Core Superpowers Explained Simply

### 1. The Action Ledger (Your Safety Net)
Every consequential action Ellie wants to take is assigned a unique ID in the **Action Ledger**. Proposal state changes are kept in an append-only transition history.
* You can see every pending action in Slack or on a private Web Dashboard.
* You can edit drafts directly in Slack by saying: *"Make the second paragraph shorter and more casual."* Ellie updates the staged card in real-time.
* Once approved, Ellie verifies that the email or calendar event was actually delivered by reading it back from Google or Proton Mail before marking it "Done".

### 2. The Claims Bank (A Heuristic Grounding Guard)
AI models love to exaggerate. If an AI writes a cover letter, it might say: *"I grew team revenue by 300% and have 15 years of experience with Kubernetes."* If that's not true, your professional credibility is ruined.

Ellie has a built-in fact-checker called the **Claims Bank Guard**:
* Supported outbound message paths are checked against configured owner sources and a claims document.
* Common numeric, contact-detail, link, title, and experience patterns are compared with those sources.
* Detected unsupported claims are rejected so the model can revise them.

This is a heuristic guard, not proof of correctness. Coverage varies by tool, source configuration,
and document type; important outbound material still needs human review.

### 3. The Dual-Engine Document Studio
Most AI assistants output plain markdown text that looks messy when copied into Word. Ellie includes two dedicated document engines:
* **The Executive Document Engine (Word & PDF):** Creates linear resumes, memos, and reports with a consistent typographic system and checks configured page-count and reading-order targets.
* **The Visual One-Pager Engine:** Creates stunning modern one-pagers, client pitch sheets, and workflow infographics using custom CSS grids, badges, and icons—automatically compressed into a single, elegant A4 page.

### 4. Interactive "Spaces" (Mini-Websites on Demand)
Sometimes a Slack message is too small for complex information (like competitive research, market comparisons, or project roadmaps). 

Instead of dumping 50 paragraphs of text into chat, Ellie can build and publish a private, self-hosted web micro-application called a **Space**. She drops a clean link in Slack:
> `https://ellie-vps.example.ts.net:10000/spaces/market-analysis`

You click the link and open a responsive, interactive dashboard featuring search filters, category pills, and clean cards.

### 5. Smart Follow-Through Tracker ("Who Owes Me What?")
One of the hardest parts of running a business is remembering who hasn't answered your emails.
* Whenever you approve an email asking a question, Ellie can automatically add it to her **Waiting Items** tracker.
* If 3 days pass without a response, Ellie surfaces a reminder in your morning brief.
* As soon as the counterparty replies, Ellie detects it, automatically marks the loop as resolved, and notifies you.

### 6. Humanizer: Natural, Trustworthy Writing
AI text often has obvious "tells"—words like *delve, testament, tapestry, spearhead*, perfectly symmetrical bullet points, and robotic pleasantries.

Ellie features a built-in **Humanizer Scanner** for English and contemporary Polish business prose.
It flags common artificial patterns and offers revision guidance; it does not guarantee a natural
voice or rewrite every finding automatically.

---

## 6. The Web Control Dashboard

Alongside Slack, Ellie runs a token- or Tailscale-protected web dashboard:

```
┌────────────────────────────────────────────────────────────────────────┐
│  ELLIE v5 CONTROL PLANE                               ● System Healthy │
├──────────────┬─────────────────────────────────────────────────────────┤
│ [✓] Approvals│ 1 Pending: Email to client@acme.com [Approve] [Drop]    │
│ [⊞] Spaces   │ 4 Active: Market Radar, Pitch Sheet, Candidate Scorecard│
│ [⏰] Routines │ 3 Active: Morning Brief (08:00), Inbox Sweep (Hourly)   │
│ [⚡] Runs     │ Live inspection of tokens, model thinking, and timings  │
│ [💰] Costs    │ Weekly spend breakdown ($0.12 today / $1.45 this week) │
└──────────────┴─────────────────────────────────────────────────────────┘
```

* **Approvals Queue (`/`):** Review pending emails or calendar invites with visual diffs.
* **Spaces Gallery (`/spaces`):** Browse, view, and search all interactive web micro-apps published by Ellie.
* **Routines Manager (`/routines`):** See when scheduled tasks last fired, view their status, or click **"Run Now"** to test a workflow on demand.
* **Cost & Health Monitor (`/costs`):** Track token usage and API costs in real time (typically just pennies a day).

---

## 7. Summary: The Future of Personal AI

Ellie v5 represents a shift away from conversational gimmicks toward **dependable, governed automation**:

1. **Single tenant by design:** One owner controls the Slack and web surfaces, while configured cloud
   providers still process task content.
2. **Consequential actions are gated:** Host code stages external writes for explicit owner approval.
3. **Claims are checked heuristically:** A Claims Bank and identity corpus reduce unsupported details,
   but human review remains necessary.
4. **Polling is separated from reasoning:** Cheap checks avoid model calls; provider usage still has a cost.

Ellie isn't just an AI that chats—she is an executive partner that genuinely owns the work.
