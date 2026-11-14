# Mỗi vai một agent: Claude, Codex, agy

Trạng thái: Bản nháp (2026-11-14), chờ anh duyệt

Nguồn em đã đọc: `src/runtime/brief.ts`, `src/runtime/orca.ts`, `src/runtime/telemetry.ts`, `src/runtime/README.md`, `src/app/supervisor.ts`, `src/app/solo.ts`, `src/app/init-project.ts`, `src/cli-app.ts`, `src/ui/activity.ts`, `README.md`, `docs/design/lead-owns-solo.md`, `orca orchestration worker-start --help`, `orca orchestration worker-stop --help`, `orca agent launch --help`, hướng dẫn `orca-cli` (phần Full Handoffs), skill `agy` (nơi agy tìm skill). Em cũng xem nơi agy lưu hội thoại: `~/.gemini/antigravity-cli/conversations/*.db` (SQLite).

---

## 1. Vì sao, mục tiêu, không làm

**Vì sao.** Mỗi tháng anh có những gói agent khác nhau. Tháng chỉ có Claude thì Claude làm mọi vai. Tháng có nhiều gói thì anh chia ra, ví dụ PM dùng Claude, Lead dùng Codex. Khi một agent hết token, anh muốn đổi sang model hoặc agent khác mà không mất phần việc đang làm dở. Hiện APOS chỉ chạy ổn với Codex. Đổi được qua `runtime.json`, nhưng những phần quanh terminal đều viết theo giao diện của Codex. Agent hết token thì dispatch treo `live` mãi (`src/runtime/README.md:5`), và anh không có cách nào chuyển việc sang agent khác.

**Mục tiêu đo được.**

| ID | Mục tiêu | Đo bằng |
| --- | --- | --- |
| M1 | Mỗi vai Lead, Worker, Reviewer chạy được bằng `codex`, `claude` hoặc `antigravity`, chọn qua cấu hình | Test adapter: `worker-start --agent <id>` đúng theo profile; chạy thật một Goal Solo với Claude và một với agy |
| M2 | Đổi agent/model của một vai bằng một lệnh, không phải sửa JSON | Test CLI `apos profile set` |
| M3 | Agent hết token thì Human được báo **đúng nguyên nhân**, trong vòng vài phút | Test với mẫu màn hình thật của từng agent |
| M4 | Từ lúc được báo, Human chuyển được việc sang agent khác bằng một lệnh. Agent mới làm tiếp trên **cùng worktree**, không mất commit lẫn thay đổi chưa commit | Test adapter đếm lệnh Orca; chạy thật một lần chuyển Claude → Codex |
| M5 | Brief dán vào mà chưa gửi được nhận ra và cứu (bấm Enter) với cả Claude và agy, không chỉ Codex | Test với mẫu màn hình thật |
| M6 | Skill PM (và các skill vai) dùng được trong Codex và agy, không chỉ Claude | Test `init` ghi ra `.agents/skills/` |

**Không làm.**
- Không đo token cho Claude và agy (anh đã nói chưa ưu tiên). `CodexSessionProbe` giữ nguyên. Với agent khác, telemetry ghi `unknown` như hiện nay khi không tìm thấy rollout.
- Không tự động chuyển agent khi hết token (phương án B). Đợt này Human tự quyết, sau có thể thêm danh sách dự phòng trên nền này.
- Không làm màn hình hoạt động (`src/ui/activity.ts`) đọc transcript của agy.
- Không đổi mặc định: không có `runtime.json` thì vẫn là Codex như bây giờ.

**Không được xảy ra.**
- Chuyển agent mà mất phần việc đang làm, hoặc tạo worktree mới.
- Báo "hết token" sai khi agent chỉ đang chạy một lệnh lâu.
- Một lần chuyển agent vì hết token bị tính là một lần thử thất bại (`soloAttempts`), làm Goal hết lượt thử oan.

## 2. Hiện trạng

| Hiện trạng | Giữ | Đổi |
| --- | --- | --- |
| Profile theo vai `lead/worker/reviewer`, mặc định Codex, ghi đè bằng `<controller home>/runtime.json`, đọc lại mỗi lần dispatch (`src/runtime/brief.ts:10-22`, `src/cli-app.ts:44`) | Định dạng file, cách đọc lại | Thêm lệnh `apos profile` để xem và sửa |
| `launchArgs` truyền thẳng `--agent/--model/--effort` cho Orca (`src/runtime/orca.ts:54`). Orca nhận `claude`, `codex`, `antigravity`... | Giữ | — |
| Resume Solo, resume package, đánh thức Lead đều gửi vào **terminal cũ** (`orca.ts:277`, `296`, `392`), nên vẫn là agent cũ dù profile đã đổi | Giữ khi profile không đổi | Profile của vai đã khác agent/model đang chạy → mở terminal mới trên cùng worktree (mục 4.4) |
| Resume Solo đòi dispatch cũ đã settle (`src/app/solo.ts:53-54`). Agent hết token không bao giờ settle | Giữ cho resume thường | Lệnh chuyển agent chủ động dừng dispatch cũ bằng `orca orchestration worker-stop` (mục 4.3) |
| Owner im lặng 15 phút → báo `owner-idle`, **chỉ** cho owner Solo (`src/app/supervisor.ts:19`, `63-72`, `85`) | Giữ làm lưới an toàn | Thêm bước đọc màn hình để nhận ra hết token; áp dụng cho cả worker, reviewer và Lead đang lập plan |
| `composerHasUnsentBrief` dò giao diện Codex: `›`, `esc to interrupt`, `[Pasted Content` (`orca.ts:443-449`) | Luật của Codex | Mỗi agent một bộ luật |
| `init` chỉ cài skill vai vào `.claude/skills/apos-<role>/` (`src/app/init-project.ts:44-50`) | Giữ | Cài thêm vào `.agents/skills/apos-<role>/`, nơi Codex và agy đọc skill của workspace |
| `docs/design/lead-owns-solo.md` ghi "không làm controller dừng được một phiên đang chạy (giới hạn của Orca)" | — | Orca nay đã có `worker-stop` ("Fence one Dispatch and stop its supervised agent terminal"). Thiết kế này dùng nó, nhưng **chỉ** khi Human ra lệnh chuyển agent |

## 3. Các phương án đã cân nhắc

**Phát hiện hết token** (anh đã chọn 1 + 2):
1. *Đọc phần cuối terminal và dò câu báo hết hạn mức của từng agent.* Báo đúng nguyên nhân, nhanh. Phải lấy mẫu câu thật và cập nhật khi agent đổi câu chữ.
2. *Chỉ dựa vào thời gian im lặng.* Không phụ thuộc agent, nhưng báo chung chung và có thể báo nhầm. Giữ làm lưới an toàn: chính là `owner-idle` đang có.

**Khi hết token thì làm gì** (anh đã chọn A):
- A. *Báo Human; Human đổi profile rồi ra lệnh chuyển; APOS dùng cách chuyển giao của Orca (dừng dispatch cũ, mở agent mới trên cùng worktree).* Đơn giản, Human nắm được hết.
- B. *Mỗi vai có danh sách dự phòng, APOS tự chuyển.* Để sau.

**Cách mở agent mới trên worktree cũ:** dùng `orca orchestration worker-start --worktree id:<cũ> --agent <mới> --run <run cũ>`, **không** dùng `orca agent launch`. `agent launch` không tạo dispatch có giám sát, nên APOS không theo dõi được `worker_done`. APOS cũng đã dùng `worker-start --worktree id:` khi terminal cũ bị Orca từ chối (`orca.ts:282`).

## 4. Thiết kế

### 4.1 Cấu hình và lệnh `apos profile`

- `runtime.json` giữ nguyên định dạng. Agent id là id của Orca: `codex`, `claude`, `antigravity`. Model là id mà agent đó nhận, ví dụ `gpt-6-luna` hoặc id model của Claude/agy.
- Lệnh mới, chỉ Human chạy (qua `assertHuman`):
  - `apos profile show`: in profile hiệu lực của ba vai và nguồn của nó (mặc định hay `runtime.json`).
  - `apos profile set <lead|worker|reviewer|all> --agent <id> [--model <id>] [--effort <level>]`: ghi vào `runtime.json`. `--effort` cần `--model`, giống Orca. Đổi `--agent` mà không kèm `--model` thì xoá model cũ, vì model của Codex không dùng được cho Claude.
  - `apos profile reset [<role>|all]`: quay về mặc định.
- Agent id lạ (không thuộc ba id trên) vẫn được ghi, kèm cảnh báo, vì Orca còn hỗ trợ agent khác. Khi đó các luật màn hình rơi về chế độ "thử mọi bộ luật" (4.2).
- PM không nằm trong `runtime.json`, vì APOS không dispatch PM: PM là phiên của chính anh. Muốn chọn agent cho PM thì anh mở agent đó; 4.6 đảm bảo skill có sẵn ở đó.

### 4.2 Đọc màn hình theo agent

Module mới `src/runtime/screens.ts` chứa luật của từng agent, đều là hàm thuần trên các dòng cuối của terminal:

```ts
type ScreenRules = {
  working(lines: string[]): boolean;          // agent đang chạy: không bao giờ báo
  unsentBrief(lines: string[]): boolean;      // brief nằm trong ô nhập mà chưa gửi
  quota(lines: string[]): string | undefined; // câu báo hết hạn mức (kèm giờ reset nếu có)
};
export const SCREENS: Record<'codex' | 'claude' | 'antigravity', ScreenRules>;
export function rulesFor(agent: string | undefined): ScreenRules[]; // agent lạ hoặc không rõ → mọi bộ luật
```

- Luật Codex chuyển nguyên từ `composerHasUnsentBrief`, giữ tên cũ làm lớp bọc để test cũ vẫn chạy.
- Luật Claude và agy **phải viết từ mẫu màn hình thật** (mục 5). Không đoán chuỗi.
- Agent đang chạy lấy từ `ref.requested.agent`. Không có thì lấy `launchReceipt(dispatchId).agent`. Vẫn không có thì thử mọi bộ luật.
- Ref của worker và reviewer cũng phải lưu `requested` như ref của Lead (`orca.ts:239`). Hiện `startPackage` và `startReviewer` chưa lưu.
- `composerPending(terminal)` đổi thành `composerPending(terminal, agent?)` và dùng `rulesFor(agent)`.

### 4.3 Phát hiện hết token và báo Human

- Trong nhánh "dispatch chưa settle" của supervisor (owner Solo `supervisor.ts:84-87`, reviewer `~214`, package `~334`, Lead đang lập plan hoặc chờ đánh thức `~459`, `~494`), thêm `noticeExhaustedAgent` chạy **trước** `owner-idle`:
  - Điều kiện: dispatch đã im lặng ít nhất `QUOTA_CHECK_IDLE_MINUTES` (đề xuất 2 phút) và màn hình không ở trạng thái `working`.
  - Đọc `terminal read`, chạy `quota()` của agent tương ứng.
  - Khớp thì ghi **một lần cho mỗi dispatch** `human-notified` loại `agent-exhausted`, gồm `{ goalId, dispatchId, role, agent, model, message }`. Note ghi cách xử lý: `apos handoff <goalId> [...] --agent <khác>`.
  - Goal vẫn ở `executing`, giống `owner-idle`. Không tự dừng gì cả.
- `owner-idle` (15 phút, báo chung chung) giữ nguyên làm lưới an toàn và mở rộng cho cùng các nhánh trên. Một dispatch đã được báo `agent-exhausted` thì không báo `owner-idle` nữa.
- `apos inbox` và trang UI hiển thị `agent-exhausted` như các notice khác.

### 4.4 Chuyển việc sang agent khác: `apos handoff`

`apos handoff <goalId> [--package <packageId> | --reviewer] [--agent <id> [--model <id>] [--effort <level>]]`, chỉ Human chạy.

- Có `--agent`: lệnh **đổi luôn profile của cả vai** trong `runtime.json` (y như `apos profile set <role> ...`, cùng quy tắc xoá model cũ khi đổi agent), rồi mới chuyển việc. Từ đó mọi dispatch sau của vai đó dùng agent mới, đến khi anh đổi lại. *(Anh quyết ngày 2026-11-14.)*
- Không có `--agent`: dùng profile hiện hành của vai, tức là anh đã `profile set` từ trước.
- Profile hiện hành trùng đúng agent/model đang chạy thì lệnh vẫn chạy (dừng rồi mở lại cùng agent), kèm cảnh báo.
- Vai được suy từ đối tượng: Lead → `lead`, `--package` → `worker`, `--reviewer` → `reviewer`. Không kèm cờ thì chuyển Lead của Goal, dù Lead đang lập plan, đang làm owner Solo hay đang điều phối Multi-WP.

Trình tự (theo kiểu intent → hành động → kết quả, giống dispatch hiện nay):
1. Tìm dispatch hiện hành của đối tượng: runtimeRef Solo, Lead, ref package, hoặc reviewDispatch. Nếu dispatch đã settle thì không cần dừng, đi thẳng bước 4.
2. Ghi `handoff-intended { key, from: dispatchId, role, to: profile }`.
3. `orca orchestration worker-stop --dispatch <cũ>`. Nếu Orca trả `stop_unknown` hoặc lỗi thì dừng lại, ghi `intent-abandoned`, báo Human vào Orca kiểm tra. Không mở agent mới khi chưa chắc agent cũ đã dừng (để tránh hai agent cùng sửa một worktree).
4. `worker-start --spec <handoff brief> --worktree id:<worktree cũ> --run <run cũ> ...launchArgs(profile(role))`. **Không** `--terminal`, **không** `new-top-level`.
5. Ghi `owner-handed-off { from, ref mới, requested }`. Reducer thay ref hiện hành bằng ref mới: `runtimeRef` hoặc `lead` cho Solo/Lead, ref package, `reviewDispatch`. **Không** tăng `soloAttempts` hay số lần thử của package.

Handoff brief (thêm vào `brief.ts`), theo vai:
- **Lead/owner Solo:** nội dung như brief gốc của vai (Lead brief khi đang lập plan, repair brief khi đang làm), cộng đoạn: "Bạn nhận lại việc từ một agent trước (`<agent>`) đã dừng vì hết hạn mức. Worktree hiện tại chứa toàn bộ việc của nó, kể cả thay đổi chưa commit. Đọc `git status`, `git log <base>..HEAD` và các báo cáo trong `.apos/goals/<id>/` trước khi làm tiếp. Đừng làm lại từ đầu." Giữ nguyên dispatch key mới, base commit cũ, activation line và đường dẫn báo cáo của lần thử hiện tại.
- **Worker:** brief package của contract và lần thử hiện tại, cộng đoạn trên.
- **Reviewer:** reviewer chưa sửa code, nên mở reviewer mới (worktree mới tại commit đang review) bằng profile hiện hành, theo `startReviewer` như cũ. Chỉ dừng cái cũ và ghi lại.

Recover sau khi mất phản hồi CLI dùng `APOS dispatch key:` trong spec như các dispatch khác (`orca.ts:396-439`).

- **Lead điều phối Multi-WP** (đang chờ hoặc đang xử lý một lượt đánh thức): Lead brief ở `phase: 'multi'`, cộng đoạn nhận lại việc, và chỉ tới trạng thái package (`apos package list <goalId>`) cùng các sự kiện đang chờ. *(Em tự quyết: đưa vào phạm vi, vì 4.3 đã báo hết token cho dispatch đánh thức.)*

Quy tắc chung: **agent mới thì luôn dùng handoff brief**. Handoff brief là brief đầy đủ của vai, có đường dẫn skill, sha256 và activation line, cộng thêm đoạn nhận lại việc. Không bao giờ gửi `repairBrief`, brief "continue the same package owner" hay `leadWakeBrief` cho một agent không có lịch sử, vì các brief đó giả định agent nhớ phiên trước.

**Controller và dispatch cũ bị dừng.** *(Em tự quyết.)*
- Từ lúc ghi `handoff-intended` tới khi có `owner-handed-off` hoặc `intent-abandoned`, controller và supervisor **không** xử lý settlement của dispatch cũ. Không ghi `worker-settled failed`, không repair, không `package-blocked`, không needs-decision.
- Khi `owner-handed-off` được ghi, settlement của dispatch cũ được coi là `handed-off`, không phải `failed`.
- Nếu `worker-start` ở bước 4 lỗi sau khi bước 3 đã dừng agent cũ: ghi `intent-abandoned` và báo Human chạy lại `apos handoff`. Goal hoặc package giữ nguyên trạng thái, không bị chặn.
- `apos handoff` nhận cả một Goal hoặc package đã bị `blocked` **chỉ vì** dispatch hiện hành settle `failed` mà chưa có báo cáo. Đây là trường hợp tick chạy trước khi Human kịp ra lệnh. Handoff gỡ block đó và không tính lần thử. Block vì lý do khác (gate đỏ, hết budget, finding) thì vẫn từ chối.

**Resume khi profile đã đổi.** Trong `resumeSolo`, `resumePackage`, `wakeLead`: nếu `profile(role)` khác agent/model mà ref đang chạy (`ref.requested`), thì thay vì gửi `--terminal <cũ>`, đi theo bước 4 ở trên (terminal mới, cùng worktree, cùng run, `launchArgs`), **với handoff brief** của vai cộng nội dung mà lần resume đó lẽ ra gửi (finding của controller, sự kiện cần đánh thức). Dispatch cũ lúc này đã settle, nên không cần `worker-stop`. Nhờ vậy anh chỉ cần `apos profile set` là các lần resume hay repair sau dùng agent mới, kể cả khi không có sự cố hết token.

### 4.5 Brief chưa gửi (cứu bằng Enter)

`unstickDispatch` giữ nguyên logic (tối đa 3 lần Enter, cách nhau 1 phút, rồi báo `stalled`), chỉ truyền agent vào `composerPending`. Luật `unsentBrief` của Claude và agy lấy từ mẫu thật (mục 5).

### 4.6 Skill cho Codex và agy

`init` ghi skill vai (`pm`, `lead`, `worker`, `reviewer`) vào cả `.claude/skills/apos-<role>/SKILL.md` lẫn `.agents/skills/apos-<role>/SKILL.md`. Theo skill `agy`, agy ưu tiên `.agents/` ở gốc workspace; Codex cũng đọc `.agents/skills/`. Builder cần kiểm lại Codex bằng một lần chạy thật. Quy tắc "đã có thì không ghi đè" và commit `apos: initialize managed project` giữ như cũ.

### 4.7 Telemetry khi không phải Codex

`recordTelemetry` vẫn gọi `CodexSessionProbe`. Với owner không phải Codex, probe trả `undefined` và ghi `unknown`, như hiện nay. Cần một test chứng minh: owner Claude không làm hỏng telemetry, không gán nhầm rollout Codex của dispatch khác cùng worktree.

## 5. Bằng chứng phải lấy trước khi viết luật

Lấy bằng `orca terminal read --terminal <handle> --json` trên agent thật trong Orca, lưu làm fixture test dưới `src/runtime/fixtures/screens/<agent>/`:

| Agent | Mẫu cần có |
| --- | --- |
| Claude | đang chạy; ô nhập rỗng chờ lệnh; brief dài dán vào chưa gửi; thông báo hết hạn mức (5 giờ và theo tuần) |
| agy | như trên |
| Codex | thông báo hết hạn mức (các mẫu khác đã có trong test) |

Không lấy được mẫu hết hạn mức thật cho một agent thì: ghi rõ trong code là luật đó *chưa xác minh*, chỉ dùng chuỗi lấy từ tài liệu chính thức hoặc mã nguồn của agent, và dựa vào `owner-idle` cho agent đó.

## 6. Để lại cho builder

- Ngưỡng `QUOTA_CHECK_IDLE_MINUTES` (đề xuất 2) và cách lấy số phút im lặng cho từng loại dispatch (dùng `inspect().idleMinutes` như `noticeIdleOwner`).
- Tên event và cách reducer trong `src/domain/transitions.ts` thay ref hiện hành cho từng loại đối tượng.
- Câu chữ cụ thể của handoff brief, miễn đủ ý ở 4.4 và giữ dưới `SPILL_LIMIT` (phần dài thì spill như hiện nay).
- Cập nhật `README.md` (bảng `runtime.json`, lệnh mới, notice mới) và `src/runtime/README.md` (`worker-stop`, agent id `antigravity`).

## 7. Ghi chú quyết định

- Chọn agent theo vai và đổi bằng lệnh: theo yêu cầu của anh.
- Phát hiện hết token bằng đọc màn hình, lấy `owner-idle` làm lưới an toàn; Human tự chuyển, không tự động: anh duyệt ngày 2026-11-14.
- Dùng cách chuyển giao của Orca, tức agent mới trên cùng worktree: theo gợi ý của anh.
- `apos handoff --agent` đổi luôn profile của cả vai: anh quyết ngày 2026-11-14.
- **Em tự quyết, anh xem lại:** (a) chuyển agent không tính là một lần thử; (b) không mở agent mới khi `worker-stop` không chắc đã dừng agent cũ; (c) resume tự mở terminal mới khi profile đã đổi; (d) Goal vẫn ở `executing` khi báo hết token, không chuyển `blocked`; (e) reviewer bị hết token thì mở reviewer mới thay vì làm tiếp; (f) agent mới luôn nhận brief đầy đủ của vai, và Lead điều phối Multi-WP cũng chuyển được; (g) trong lúc chuyển, dispatch cũ không bị coi là thất bại, và handoff gỡ được block do chính dispatch đó gây ra.
