# pasukkun user guide

pasukkun collects newly published security vulnerabilities, checks whether the **package versions your projects actually install** are affected, and notifies you on Telegram, Discord, or 착착 (Chakchak).

This guide explains how to use each menu. The app's screens are in Korean, so on-screen labels are written as they appear, followed by an English description.

## Getting started

1. On the first screen, click **GitHub 로 계속하기** (Continue with GitHub).
2. When GitHub asks for permission, click **Authorize**.
3. If this is your first visit, your account is created right away and you land on the dashboard.

- There is no separate password.
- Only your public GitHub profile (username and name) is read. Your repositories and email are not accessed by the login.
- You stay signed in for 14 days.
- If the login screen says GitHub login is not configured, contact the service operator.

**Recommended first steps**

1. In **관심 기술** (Technologies of interest), pick the languages and frameworks you use.
2. In **프로젝트** (Projects), click **GitHub 저장소 가져오기** (Import GitHub repositories) and pick your repositories. You can also register a project by hand and upload a lockfile.
3. In **알림 설정** (Notification settings), connect Telegram, Discord, or 착착 and create a subscription rule.

## Left menu

| Menu | What it does |
|-|-|
| 대시보드 (Dashboard) | Items to look at now, recent advisories, Korean public notices, and data collection status at a glance |
| 비상 달력 (Emergency calendar) | Publication dates, KEV deadlines, review dates, and planned fix dates on a monthly calendar |
| 취약점 피드 (Vulnerability feed) | Search and filter all collected vulnerabilities |
| 프로젝트 (Projects) | Import or register projects and scan their dependencies |
| 분석 결과 (Findings) | Impact analysis results across all projects |
| 패키지별 조치 (Package remediation) | Which package upgrade resolves the most findings |
| 관심 기술 (Technologies of interest) | Save the technologies you care about |
| 보안 브리핑 (Security briefing) | Read every security briefing that was sent, and see when the next one goes out |
| 알림 설정 (Notification settings) | Connect channels and decide what you receive and when |
| 발송 이력 (Delivery history) | Check whether notifications were actually sent |
| 수집 상태 (Collection status) | Check that vulnerability data is coming in correctly |

At the top of every page there is a search box for CVE IDs, packages, and keywords (results open in the vulnerability feed), and a collection status pill showing whether collection is healthy and when it last succeeded. Click the pill to open **수집 상태**.

At the bottom of the menu you can see your GitHub username, switch **다크/라이트** (dark/light), and **로그아웃** (log out).

## 대시보드 (Dashboard)

**Number cards at the top**: click a number to open the findings list with the same filter. The card count and the list count always match.

| Card | Meaning |
|-|-|
| 긴급 검토 (Urgent review) | Priority is "urgent" and nothing has been done yet |
| 미조치 (Open) | Status is unreviewed, in review, or planned |
| 영향 버전 일치 (Affected version) | The installed version is inside the advisory's affected range |
| 판단 불가 (Undetermined) | Not enough version information to decide |
| 재확인 필요 (Needs recheck) | The project or advisory changed after you reviewed it |
| 재검토 기한 경과 (Review overdue) | You accepted the risk, and the date to look again has passed |

**Below the cards**
- **긴급 검토 항목** (Urgent items): what to look at first.
- **최근 공개된 취약점** (Recently published): recent advisories matching your saved technologies. This means the advisory is related, not that your project is affected. If the list is empty, check how your technology groups are combined (see [Technologies of interest](#관심-기술-technologies-of-interest)).
- **내 프로젝트** (My projects): latest scan status and urgent/open counts per project.
- **국내 보안공지** (Korean security notices): the latest KISA 보호나라 security notices. They have no affected version data, so they are not matched against your projects; open them and check yourself.
- **데이터 수집 상태** (Data collection status): each source shows normal / collecting / delayed / failed.

## 비상 달력 (Emergency calendar)

A monthly view of what was published and what is due.

- Move between months with the arrows, or jump back with **오늘** (Today).
- Choose a view at the top right:
  - **내 프로젝트 영향** (My project impact): vulnerabilities affecting your projects on their publication date, CISA KEV action deadlines for them, risk acceptance review dates, and planned fix dates.
  - **중요 이슈** (Important issues): vulnerabilities newly added to CISA KEV (confirmed exploited), critical advisories for your saved technologies, all KEV deadlines, and KISA security notices.
  - **관심 기술** (Technologies of interest): advisories matching your saved technologies.
- Colors: 긴급 (urgent), 높음 (high), 보통 (medium), KEV 조치 기한 (KEV deadline, black), 조치 예정 (planned fix, blue), 재검토 기한 (review date, purple), 국내 보안공지 (Korean notice, gray). The legend under the toolbar shows the colors used in the current view.
- Click an item to open it. When a day has more than three items, click **+N건** to see them all.
- To put a fix on the calendar, set a **조치 예정일** (planned fix date) when you change a finding's status to 조치 예정 (planned).

## 취약점 피드 (Vulnerability feed)

Everything the service has collected.

**Search and sort**
- **Search** by CVE or GHSA ID, package name, or title.
- **Sort** by published date, recently modified, severity, or EPSS.

**Filters** (open with the filter button)
- **Technologies**: pick by language, framework, runtime, infrastructure, or database.
  - Several picks within one group match if **any** of them matches.
  - Between groups, **그룹 간 결합** (group combination) decides:
    - 모든 그룹 충족 (AND): an advisory must match every picked group.
    - 하나라도 일치 (OR): matching any pick is enough.
- Filter by **severity**, **known exploited (KEV)**, **patch available**, **published date**, and **last modified date**.
- **미분류만 보기** (Unclassified only): advisories not mapped to any technology.
- **철회 공지 포함** (Include withdrawn): also show advisories the source withdrew.
- **프로젝트와의 관련 상태 보기** (Show relation to a project): pick a project to see how each advisory relates to it, and filter by version match and remediation status.

**Applied filters** appear as chips above the list. Remove one with its X, or clear everything with **전체 초기화** (Reset all). With no filters, the whole collection is shown.

**Screen filters are not your saved technologies.** The feed opens with your saved technologies applied. Changing filters here affects only this screen, not your notifications. To keep a new selection, click **현재 선택을 관심 기술로 저장** (Save as my technologies). To go back, click **저장된 관심 기술로 되돌리기** (Restore saved technologies).

If a "collection delayed" notice appears at the top, some recent advisories may not be in yet.

### Vulnerability details

Click a title in the list.

- **어떤 문제인가** (What is the problem): the advisory text.
- **어떤 버전과 조건에서 발생하는가** (Affected versions and conditions): affected ranges, fixed versions, and CVSS per source.
- **내 프로젝트에서 확인된 사실** (Facts in my projects): which of your projects match, and their status.
- **대응 방법** (Remediation): confirmed fixed versions, CISA KEV required action, and EPSS.
- **영향 기술** (Affected technologies): why the advisory was mapped to each technology.
- **공식 출처** (Official sources): links to the original advisories.
- When sources disagree, a **출처 간 차이** (Source differences) notice appears at the top.

## 프로젝트 (Projects)

### Import from GitHub (recommended)

1. Click **GitHub 저장소 가져오기** (Import GitHub repositories).
2. GitHub opens. The first time, approve the pasukkun app. After that it returns without asking.
3. Back in pasukkun, a list of repositories appears. It shows repositories where the pasukkun app is installed and that you can access.
   - If a repository is missing, click **목록에 없는 저장소 추가** (Add a repository not in the list). Install the app on GitHub or change its repository selection, and you come straight back to the list.
4. Check the repositories you want (up to 20 at once) and click **다음** (Next).
5. pasukkun finds the lockfiles in each repository (package-lock.json, pnpm-lock.yaml, yarn.lock). The one at the top of the repository is checked by default. Each checked lockfile becomes one project.
6. Click **가져오기** (Import). The project gets its name and description from the repository, the lockfile is fetched, and the first scan starts. Technologies are filled in from the direct dependencies.

After that, pasukkun checks every 6 hours whether the lockfile changed. If it changed, the new version is registered and scanned automatically.

Every 30 days, connect to GitHub again so pasukkun can confirm you still have access to the repository. Until you do, the project shows **연결 끊김** (Disconnected) and the lockfile is not fetched.
1. Open the project and click **GitHub 로 다시 연결** (Reconnect to GitHub) on its GitHub card.
2. Approve on GitHub. If you can still access the repository, the lockfile is fetched again right away. You can close the repository list that opens.

- pasukkun reads only the chosen lockfile and the package.json next to it. It does not read your source code.
- No GitHub token is stored. Only the repository and file location are kept.
- To stop, remove the app from the repository on GitHub, or use **연결 해제** (Disconnect) on the project.

### Register by hand

Click **프로젝트 등록** (Register project) and fill in the form.

| Field | Description |
|-|-|
| 프로젝트명 · 설명 (Name · Description) | Shown on screens and in notifications |
| 환경 (Environment) | Production / development / test, pick all that apply. None picked counts as production |
| 인터넷 공개 여부 (Internet exposure) | Public / internal / unknown. Unknown is treated like public |
| 런타임 · 운영체제 · 배포판 · 아키텍처 (Runtime, OS, distro, architecture) | For your records only. Not used for automatic decisions |
| 사용 기술 (Technologies) | Languages and frameworks the project uses |
| 담당 메모 (Notes) | Free text |

Environment and exposure feed directly into priority, so set them accurately. Imported projects start with no environment and unknown exposure; adjust them in the **프로젝트 정보** (Project info) tab.

### 구성 · 의존성 (Configuration · Dependencies) tab

**For projects imported from GitHub**, a **GitHub 저장소** card appears at the top:
- Repository, lockfile path, branch and commit, last check, and last applied change.
- Status: **연결됨** (Connected), **확인 실패** (Check failed, retried at the next check), or **연결 끊김** (Disconnected, the app no longer has access to the repository).
- **지금 확인** (Check now): look for lockfile changes right away.
- **연결 해제** (Disconnect): stop checking. The project and its results stay.

**Uploading a lockfile yourself**
1. Choose one of two ways:
   - **lockfile 업로드** (Upload lockfile): pick a package-lock.json, pnpm-lock.yaml, or yarn.lock. package.json is optional; it is used to cross-check, and for Yarn 1 it is needed to tell direct dependencies apart.
   - **패키지 직접 입력** (Enter packages): one per line as package-name@exact-version. Ranges like ^1.2.0 are not accepted, and transitive dependencies are not scanned this way.
2. Click **내용 확인** (Check contents) to see how many packages can be scanned, what cannot be scanned, and how many packages have several installed versions.
3. Click **이 구성으로 저장하고 검사 시작** (Save and start scanning).

- When scanning, only **package names and versions** are sent to the public vulnerability lookup service (OSV). Source code and file contents are never sent.
- Upload the lockfile that is actually deployed, so the results reflect production.
- **구성 스냅샷** (Configuration snapshots) below lists previous configurations, their packages, dependency paths, and items that could not be scanned. The latest 10 are kept.

### 분석 결과 (Findings) tab

- Affected items for this project, sorted by priority.
- Filter by version match, priority, remediation status, needs recheck, review overdue, and include resolved.
- When there are no results, the screen tells you why:
  - **본 검사 범위에서 알려진 취약점 일치 없음** (No known vulnerability matched in this scan scope): the scan finished and nothing matched.
  - **검사 미완료** (Scan not complete): no scan yet, or it failed. This does not mean "no vulnerabilities".

### 검사 이력 (Scan history) tab

- Each scan shows the configuration used, time, number of results, items not scanned, and the data source status at that moment.
- **부분 완료** (Partially complete) means some external lookups failed. Do not treat missing items as safe.

### Running a scan

- **검사 실행** (Run scan) at the top right scans the current configuration again.
- Every project is rescanned once a day automatically.
- When a new vulnerability is published, it is matched against your projects automatically, with no rescan needed.

### 프로젝트 정보 (Project info) tab

- Edit the registration details. Changing environment or exposure recalculates priorities and marks existing reviews as needing a recheck.
- At the bottom you can delete the project. Reviews and remediation records are deleted too, and this cannot be undone.

## 분석 결과 (Findings)

Results for all projects in one place. Narrow down by project; the filters are the same as in a project's findings tab.

### Labels in the table

| Label | Meaning |
|-|-|
| 영향 버전 일치 (Affected version) | The installed version is inside the affected range |
| 판단 불가 (Undetermined) | Not enough information, or sources disagree on the range |
| 악용 조건 (Exploit conditions) | Not analyzed / needs checking / conditions met / conditions not met |
| 대응 우선순위 (Priority) | How soon to act for this project: urgent, high, needs checking, medium, low |
| 심각도 (Severity) | Severity of the vulnerability itself (different from priority) |
| 악성 패키지 (Malicious package) | This version is reported to contain malicious code. Always urgent, even in internal or development-only projects |
| 직접 / 전이 의존성 (Direct / transitive) | Installed directly, or pulled in by another package |
| 개발 의존성 (Dev dependency) | Used for development. Not excluded from risk |

**A matching version does not mean you can actually be attacked.** pasukkun does not decide whether you use the vulnerable feature; confirm it yourself with the review below.

### Finding details

Click an item.

- **확인된 사실 - 버전 매칭** (Facts - version match): why this was decided, with the installed version, affected range, assessment per source, install location, and dependency path.
- **대응 방법** (Remediation): the fixed version to upgrade to from this version, chosen so that no source still lists it as affected. If only a newer release line has a fix, it says so. If no fix information exists, it shows "patch not confirmed" and does not guess. For a **악성 패키지** (Malicious package), it shows what to do instead: remove the package or pin a version the advisory marks as safe, replace the tokens and keys used on computers and CI where it was installed, and check the builds and deployments run since then.
- **대응 우선순위** (Priority): which rule produced this level. **규칙 보기** (View rules) shows all rules.

**Exploit condition review** (아직 확인하지 못한 조건)
1. For each check item taken from the advisory, choose applies / does not apply / could not check.
2. Choose a **판정** (verdict: needs checking / conditions met / conditions not met) and write the **판단 근거** (reasoning). The reasoning is required.
3. Click **검토 기록** (Record review).

- The record keeps the author (GitHub username) and time, and affects priority.
- If the configuration or advisory changes later, it is marked as needing a recheck.

**Remediation status**
- Choose unreviewed / in review / planned / risk accepted / done and click **상태 변경** (Change status).
- **조치 예정** (Planned) can have an optional **조치 예정일** (planned fix date), which appears on the emergency calendar.
- **위험 수용** (Risk accepted) requires a reason and a date to review again.
- Marking "done" does not change the version match. Upgrade the package and scan the new lockfile (projects imported from GitHub do this automatically); resolved items then show as no longer detected.

## 패키지별 조치 (Package remediation)

Affected findings grouped by package and installed version, so you can start with the upgrade that clears the most.

- Each row shows the package, **설치 버전 → 올릴 버전** (installed version → version to upgrade to), how many findings that upgrade resolves, the affected projects, and the highest priority. A **KEV** label means at least one of them is known to be exploited.
- The version to upgrade to is the highest fixed version confirmed among that row's findings, checked against every advisory for that package. If it is still inside another advisory's affected range, the next fixed version that clears all of them is shown instead. If none does, it shows **패치 미확인** (Patch not confirmed). If a fix exists only in a newer release line, check compatibility before upgrading.
- **패치 미확인** (Patch not confirmed) counts findings with no fixed version information; upgrading may not resolve them.
- Click a row to see its findings and open each one.
- Narrow down with the project selector at the top right.
- After upgrading, scan the new lockfile (automatic for projects imported from GitHub) to see the findings resolved.

## 관심 기술 (Technologies of interest)

- Pick technologies from the language, framework, runtime, infrastructure, and database groups, then click **저장** (Save).
- Saved technologies are used in two places: the feed's default filter, and "technology interest" notification rules.
- **Group combination**
  - 모든 그룹에 해당 (AND): picking TypeScript and PostgreSQL keeps only advisories matching both. PostgreSQL's own advisories drop out.
  - 하나라도 해당 (OR): choose this to receive advisories for each picked technology.
- Labels next to technologies:
  - **정밀 검사** (Precise scan): installed versions can be compared once a project is imported.
  - **피드만** (Feed only): related advisories are shown, but versions are not compared.
- Technologies decide which advisories are related. They do not decide whether a project is affected.

## 알림 설정 (Notification settings)

There are three tabs: connect a channel, create rules, then check your time zone.

### 채널 (Channels) tab

Notifications are sent by the service's own bots. You connect with buttons; there is nothing to paste.

**Telegram**
1. Click **텔레그램 연결** (Connect Telegram), name the channel, and click **연결 링크 만들기** (Create link).
2. Choose where to receive:
   - **개인 대화로 받기** (Private chat): Telegram opens; press **Start**.
   - **그룹에 추가해서 받기** (Add to a group): choose the group.
3. When connected, the window closes by itself and a confirmation message arrives in Telegram. The link works once and expires in 15 minutes.

**Discord**
1. Click **디스코드 연결** (Connect Discord), name the channel, and click **디스코드로 이동** (Go to Discord).
2. On Discord, choose the server to add the bot to and approve. Only servers you can manage are listed.
3. Back in pasukkun, choose the channel and click **이 채널로 연결** (Connect this channel). A confirmation message is posted there. If the channel list is empty, give the bot permission to view and post in the channel in your Discord server settings.

**착착 (Chakchak)**
1. Once, in 착착: open **커스텀 봇** (Custom bots) from the workspace menu, create a bot (for example, pasukkun), invite it to the channel where you want alerts, and add an **알림 받기** (Receive alerts) job for that channel. Give the bot's receive address to the pasukkun operator for the server settings. Anyone who has the address can post to that channel as the bot, so keep it private.
2. In pasukkun, click **착착 연결** (Connect 착착), name the channel, and click **확인 메시지 보내고 연결** (Send confirmation and connect). The bot posts a confirmation message in the channel.
3. Notifications are posted by the bot in that channel. The server holds one address, so everyone who connects 착착 on this server receives in the same channel.
4. For morning and afternoon briefings, create a rule with **매일** (Daily) at two times, such as 09:00 and 14:00, set **모아 받는 형식** (Digest format) to **보안 브리핑** (Security briefing), and choose this channel.
5. If the receive address is deleted or turned off, or the bot leaves the channel, the channel turns **연결 끊김** (Disconnected). Fix it in 착착 (a deleted address needs a new one in the server settings), then click **다시 연결** (Reconnect).

**On a connected channel**
- **테스트 발송** (Send test): sends one confirmation message, also recorded in delivery history.
- **일시 중지 / 재개** (Pause / Resume): notifications due while paused are cancelled.
- **이름 바꾸기** (Rename), **삭제** (Delete).
- **다시 연결** (Reconnect): shown when the bot was blocked or removed and the channel turned **연결 끊김** (Disconnected). Other people's channels are not affected.

If the connect buttons are disabled, the bot is not set up on this server yet. Contact the operator.

### 구독 규칙 (Subscription rules) tab: what, when, and in what words

There are two kinds of rules:
- **관심 기술 알림** (Technology interest): advisories matching your saved technologies. Related, not necessarily affecting your projects.
- **프로젝트 영향 알림** (Project impact): when an installed version in your project falls inside an affected range. On a project's first scan, you get one summary instead of one message per existing item. Malicious packages found in that scan are named in the summary.

Click **규칙 추가** (Add rule) and set:

| Field | Description |
|-|-|
| 이름 (Name) | Rule name |
| 알릴 변화 (Changes to notify) | New vulnerability, new affected version, newly in KEV, fixed version confirmed, affected range changed, priority raised, first scan summary |
| 심각도 기준 (Minimum severity) | Only this severity or higher. Advisories without severity are always included |
| 받는 시간 (When to receive) | See below |
| 보낼 채널 (Channels) | One or more connected channels |
| 대상 프로젝트 (Projects) | For project impact rules. Empty means all your projects |
| 알림 문구 (Message text) | See below |

**When to receive**

| Option | Behavior |
|-|-|
| 즉시 (Immediately) | Sent as soon as it happens |
| 매일 (Daily) | Collected and sent at the times you set (up to 6 a day, add with **시각 추가**). Check **주말(토·일)은 다른 시각에 받기** to use different times on Saturday and Sunday, or none at all |
| 매주 (Weekly) | Collected and sent on the chosen weekdays at the set time |
| N시간마다 (Every N hours) | Collected every 1, 2, 3, 4, 6, 8, or 12 hours, counted from midnight (every 6 hours means 00:00, 06:00, 12:00, 18:00) |

Times follow the time zone in the **시간대 · 방해 금지** tab.

When a rule collects instead of sending immediately, **모아 받는 형식** (Digest format) chooses what arrives at each time:

| Format | What you get |
|-|-|
| 알림 목록 (Alert list) | The titles of the collected alerts. Nothing is sent when nothing was collected |
| 보안 브리핑 (Security briefing) | A status report sent at every set time, even when nothing new arrived |

A security briefing is titled by when it is sent: 아침 보안 브리핑(밤사이 발생분) (morning, overnight issues) for the first one of the day, 오후 보안 브리핑(오늘 발생분) (afternoon, today's issues) for later ones, and 주말 보안 브리핑 (weekend) on Saturday and Sunday. It contains:

- A one-line headline and a short summary: how many new issues came in since the last briefing, whether any are in KEV, how many of your projects are affected, and how many patches were confirmed.
- **새 이슈** (New issues): each issue with its priority, KEV status, affected projects, and whether action is needed (조치 필요) or it is for reference only (참고).
- **패치 확인** (Patch check): items that the latest scans no longer find because the installed version changed, and items you marked 조치 완료 (Done) that will be confirmed at the next check (조치 보고).
- **국내 보안공지** (KISA notices): KISA notices collected since the last briefing.

For a GitHub project, pasukkun rechecks the lockfile on its own, so an item marked 조치 완료 moves to the confirmed patches after you push the upgrade.

Each briefing message has a **브리핑 전문 보기** (Full briefing) link that opens it in the **보안 브리핑** menu.

**Writing your own message** (알림 문구 직접 정하기)

Turn on the switch to start from the default template and edit it.

1. Write the text in the template box.
2. Click a placeholder such as {제목} to insert it at the cursor. It is replaced with the real value when sent.
3. Check the **미리보기** (Preview) filled with sample data.
4. Click **저장** (Save).

- **기본 틀로 되돌리기** (Restore default) brings back the default. Turning the switch off uses the default format.
- Unknown placeholders are reported when you save. Placeholders without a value become "-".
- Text is sent as plain text. HTML and mentions like @everyone do not work.
- Alert lists, security briefings, and first scan summaries use their own fixed format, not your template.
- For a malicious package, a **[악성 패키지]** (Malicious package) notice is always added above your text.

| Placeholder | Value |
|-|-|
| {이벤트} | Kind of notification |
| {제목} | Vulnerability title |
| {식별자} | CVE / GHSA IDs |
| {심각도} | Critical / high / medium / low / not provided |
| {CVSS} | CVSS score |
| {우선순위} | Priority (project alerts) |
| {프로젝트} | Project name (project alerts) |
| {패키지} | Affected package name |
| {현재버전} | Installed version |
| {수정버전} | Confirmed fixed version |
| {영향패키지} | All affected packages |
| {판단} | Reasoning for the decision |
| {악용조건} | Exploit condition status |
| {확인할조건} | Conditions to check |
| {관련기술} | Related technologies (technology alerts) |
| {KEV} | Whether listed in CISA KEV |
| {EPSS} | EPSS (estimated probability of exploitation activity in the next 30 days) |
| {링크} | Link to the details in pasukkun |
| {원문} | Link to the original advisory |

In the rule list, the switch turns a rule on or off, the pencil edits it, and the trash can deletes it. A warning appears under a rule whose channel is paused or disconnected.

### 시간대 · 방해 금지 (Time zone · Do not disturb) tab

- **시간대** (Time zone): the basis for all notification times.
- **방해 금지 시간 사용** (Use quiet hours): notifications during these hours are held and sent when quiet hours end.
- **긴급 알림은 방해 금지 시간에도 보내기** (Send urgent alerts during quiet hours): when on, urgent alerts go out right away.

## 보안 브리핑 (Security briefing)

Every security briefing that was sent is kept here, newest first.

Three cards at the top:

| Card | Shows |
|-|-|
| 다음 발송 (Next send) | When the next briefing goes out, and each briefing rule's schedule |
| 모인 알림 (Collected) | How many alerts are waiting for the next briefing, per channel |
| AI 요약 (AI summary) | Whether AI summary is on. When the server is set up for it, Claude rewrites each briefing's headline, summary, and issue lines in Korean. Otherwise briefings use the fixed format |

Under **지난 브리핑** (Past briefings), each briefing shows:

- Its title, the time it was sent, and the time it collected from. **AI 요약** marks briefings written with AI summary.
- The rule name and each channel it went to, with whether it was sent (보냄) or failed (보내지 못함).
- The headline, the summary, and the numbered issue list. Click an issue to open its finding or vulnerability details.
- **패치 확인** (Patch check) and **국내 보안공지** (KISA notices).

Click a briefing's title to get a link to that briefing alone. Opening that link scrolls to it and highlights it. **더 보기** (More) loads older briefings. Briefings are kept for 180 days.

If you have no briefing rule yet, go to **알림 설정**, set **받는 시간** (When to receive) on a rule, and choose **보안 브리핑** as **모아 받는 형식**.

## 발송 이력 (Delivery history)

How each notification was handled. Filter by **상태** (Status).

| Status | Meaning |
|-|-|
| 발송됨 / 요약에 포함 (Sent / In digest) | Delivered, or included in a digest |
| 발송 대기 / 재시도 중 (Pending / Retrying) | About to be sent. If the service asks to slow down, it waits and retries |
| 방해 금지 보류 / 요약 대기 (Held / Awaiting digest) | Sent when quiet hours end or at the digest time |
| 최종 실패 (Failed) | Several attempts failed. The reason is shown |
| 중복 억제 (Duplicate suppressed) | The same notification already exists, so it was not sent again |
| 취소됨 (Cancelled) | The channel was paused or the subject no longer applies |

Rarely, the same notification may arrive twice.

## 수집 상태 (Collection status)

- A summary line at the top shows the last collection time and how many sources are normal, failing, or delayed.
- **데이터 소스** (Data sources): role, status (normal / collecting / delayed / failed), last success, interval, **최근 신규** (items added or changed in the last run), and **누적 항목** (items stored from that source). A failed collection is shown as failed, never as "no vulnerabilities".
- **최근 수집 실행** (Recent runs): result and number of items for each run.
- **대응 우선순위 규칙** (Priority rules): every rule and threshold used for priority.

| Source | Role |
|-|-|
| GitHub Advisory | Open source package advisories and affected versions |
| OSV | Vulnerabilities for the installed versions in your projects (during scans) |
| NVD | CVE details, CVSS scores, affected products |
| CISA KEV | Vulnerabilities confirmed to be exploited |
| FIRST EPSS | Estimated probability of exploitation activity in the next 30 days |
| KISA 보호나라 | Korean public security notices (shown as related notices only, not matched by version) |

## Good to know

- **A matching version is not proof of exposure.** Check whether you use the vulnerable feature with the exploit condition review.
- **A malicious package is not a vulnerability.** The code in that version is itself harmful, so upgrading alone is not enough. Follow the steps in **대응 방법** (Remediation).
- **No CVSS score does not mean low risk.** Items without a score are kept high for review.
- **Not in KEV does not mean not exploited.** KEV only lists confirmed cases.
- **EPSS is not the chance that your project gets attacked.** It estimates how likely the vulnerability is to be exploited somewhere in the next 30 days.
- **Supported scope**
  - Installed-version scanning covers npm, pnpm, and Yarn projects (package-lock.json, pnpm-lock.yaml, yarn.lock).
  - Runtime and OS versions are recorded but not judged automatically. Related advisories are marked for manual review.
- **What leaves the server**: only package names and versions during scans. Never source code.
