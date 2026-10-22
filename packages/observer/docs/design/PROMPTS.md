# ImageGen prompts

Generated on October 22, 2026 with the built-in ImageGen tool. No CLI fallback,
source screenshot, or live database content was used. Each call set
`transparent_background: false`; other model/output settings used the tool defaults.
The exact prompt for each image was **Common direction** followed immediately by
its corresponding **Screen** section below. Image generation is nondeterministic;
these prompts preserve intent, not a promise of identical pixels.

## Common direction

```text
Use case: ui-mockup
Asset type: high-fidelity desktop application design reference, intended for a public open-source repository.
Primary request: create a polished, believable screenshot-style mockup of "Dispatch Observer", an Electron desktop app for read-only inspection of Pi Durable agents. This is a design concept using entirely synthetic data.
Style: restrained, beautiful developer productivity application. Preserve this established visual direction: white canvas #ffffff, very pale gray sidebar and inspector #f6f7f9, dark ink #202630, muted text #606b79, hairline borders #e4e7ec, cobalt selection #2963bc on #eef4ff, subdued green #287552 for completed, amber #89600e for waiting, red #ac4850 for errors. Inter/system sans typography, monospaced tool arguments, 8px corner radii, 1px borders. Quiet generous spacing, precise alignment, readable density, no gradients, no glass effects, no glowing graphs, no marketing decoration.
Composition: one flat front-facing app window filling a wide 16:10 image, around 1920x1200; no computer device, no photograph, no perspective, no surrounding desktop wallpaper. Slim native macOS title bar with traffic lights and centered "Dispatch Observer". App body with connection sidebar 216px, central work area, detail inspector 370px. Crisp intentional UI hierarchy. Use short accurate text and leave whitespace instead of filling with unreadable paragraphs.
Data constraints: ONLY fictional examples: "Workspace", "Coordinator", "Researcher", "Reviewer", "Example review". No real people, businesses, private paths, account IDs, or private hostnames. A small "Design concept · Sample data" label in bottom status bar. No vendor logos except plain title. No chat composer, no execute, retry, approve, stop-agent or deployment buttons. Playback controls only navigate saved records. Native Pi details tucked into a disclosure, not loud technical chrome.
```

## Screen 01 — Live activity

```text

Screen: LIVE ACTIVITY, selected source "Workspace", selected agent "Coordinator". Sidebar section "Connections": Workspace (Postgres, connected), Local sandbox (SQLite), Remote review (SSH). A small "+ Add connection" control at bottom. Under Workspace, show agent names Coordinator, Researcher, Reviewer.
Header: breadcrumb "Workspace / Coordinator", title "Review the example change", subtitle "Started 2 minutes ago", a subtle blue badge "Working", and separate small source freshness text "Updated just now". Tab strip "Structure" selected, "Timeline", "Conversation".
Central pane: elegant indented task tree with thin vertical connectors. Top node "Coordinator" and subtitle "Waiting for research". Child node "Researcher" selected with pale blue fill, label "Reading source files" and blue "Working". Child node "Reviewer", subtitle "Waiting for research", amber "Waiting". A completed child "Gather context" with green "Completed". Small disclosure toggle "Native tasks" off. This hierarchy is the main visual, not a tangled node diagram.
Right inspector: eyebrow "RESEARCHER", title "Reading source files". Tabs "Activity" selected, "Conversation". A tool card "read_file", "In progress", and readable monospace argument path "src/worker.ts". Below a short timeline: "14:32:08 · Tool started", "14:32:05 · Search completed", "14:32:01 · Assignment received". Lower section "Assignment" with sentence "Find the cause of the connection error." Footer linklike disclosure "Native record details".
Bottom full-width low-profile activity strip: small tick timeline from "0:00" to "2:14", a blue "Following live" indicator and "Pause following" control. The app feels useful, calm, carefully designed, and genuinely implementable. Do not add charts or large statistics.
```

## Screen 02 — Workflow playback

```text

Screen: RECORDED WORKFLOW PLAYBACK. Preserve the same calm visual system and sidebar.
Sidebar: "Connections" with Workspace (Postgres), Local sandbox (SQLite), Remote review (SSH) selected. Below selection a single agent "Review agent".
Header breadcrumb "Remote review / Review agent", title "Example review", subtitle "Recorded activity · Today at 14:30", badge "Completed". Separate small source label "Last read 14:36". A workflow phase strip beneath: "Prepare" completed, "Research" completed, "Export" completed, "Deliver" completed, "Finish" completed. Caption "Final workflow state" so phases are not mistaken for reconstructed history.
Main tabs "Structure", "Timeline" selected, "Conversation".
Central timeline view with a subtle time axis 0:00, 0:30, 1:00, 1:30, 2:00, 2:30. Lanes labelled "Review agent", "Research attempt 1", "Research attempt 2", "Export", "Deliver". First attempt spans 0:10 to 0:32 in muted red, second attempt spans 0:38 to 1:43 in muted blue, Export and Deliver muted green later. A thin blue playhead is positioned at 0:32 and does NOT pass through all phases. Use simple horizontal strips and clear readable labels, never a dashboard of graphs.
Below timeline show selected activity row "14:30:32 · Attempt 1 ended" with red small badge "Failed", followed by "14:30:38 · Attempt 2 started" and "14:31:43 · Research completed". Near first attempt a small honest note "Intermediate phase changes were not retained." Do not show fabricated detailed checkpoint history.
Right inspector header "RESEARCH ATTEMPT 1", title "Source request failed", red badge "Failed". Tool card "fetch_source" with readable Arguments line 'url: "https://example.com/reference"' and a Result field "Request timed out". Metadata "Duration 22 s". A small disclosure "Native record details".
Bottom persistent playback bar: clear "Recorded playback", a Play triangle button, Previous and Next step icon buttons, speed "1×", a small progress slider, counter "8 of 24 events", and a right-aligned outlined "Return to live" button. Footnote "Playback only changes this view." Small bottom-right "Design concept · Sample data".
No execution buttons. No rerun or retry control. This is viewing past events, never running tools. Do not include real infrastructure or people.
```

## Screen 03 — Add a connection

```text

Screen: ADD A CONNECTION. Same native app titlebar, white canvas, pale gray sidebar, cobalt blue accents and Inter/system type. This is the entry screen for configuring a data source, not a dashboard.
Left sidebar Connections: "Workspace" with sublabel Postgres, "Local sandbox" with sublabel SQLite, and "+ Add connection" selected in pale blue.
Main central content, max width about 820px with substantial whitespace: eyebrow "CONNECTIONS", title "Add a connection", short subtitle "Open agent activity where it already lives."
At top show three evenly-sized quiet type selector cards: "Local SQLite" (file icon), "Postgres" selected in pale blue (database icon), "Remote SQLite" (terminal icon). Under the cards, the Postgres connection form with labelled fields, exact short text:
"Name" = "Example workspace"
"Host" = "db.example.com"
"Port" = "5432"
"Database" = "agents"
"User" = "observer"
"Password" = empty field with placeholder "Enter password"
"TLS" = dropdown "Verify certificate"
Then a subtle checkbox row checked "Connect through a tunnel". Beneath it a compact segmented selector "SSH" selected and "AWS SSM". Only SSH fields shown:
"SSH host" = "gateway.example.com"
"SSH user" = "observer"
"Authentication" = dropdown "SSH agent"
A light divider.
Near bottom a concise helper line "Read-only access. Your agents keep running."
Bottom actions aligned right: quiet "Cancel", outlined "Test connection", primary blue "Continue". This is step 1 of 2, "Connection → Select store" indicated subtly above the action row. Store selection happens after connecting.
Right narrow panel titled "Choose a source", with three simple text rows: "Local SQLite · Pick a file on this computer", "Postgres · Connect directly or through a tunnel", "Remote SQLite · Read through SSH or AWS SSM". Below a pale gray information card: "Credentials stay on this device." No warning-colored banners, no technical framework details, no code snippets.
Footer "Design concept · Sample data". Clear, spacious, useful and implementable. No real credentials or people, no fake password dots, no personal paths, no charts.
```
