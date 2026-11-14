# Lead tự làm owner ở Solo

Trạng thái: Đã duyệt (2026-11-14)

Nguồn em đã đọc: `src/cli-app.ts`, `src/app/solo.ts`, `src/app/supervisor.ts`, `src/app/controller.ts`, `src/app/replan.ts`, `src/runtime/orca.ts`, `src/runtime/brief.ts`, `src/domain/transitions.ts`, `skills/apos-lead/SKILL.md`, `skills/apos-core/SKILL.md`, `docs/FINAL-DESIGN.md`, `README.md`. Không có trong repo: tài liệu về cách anh đang mở Lead (Q0, dùng giả định ở mục 3), kết quả Hard12/SQLFMT.

---

## 1. Vấn đề, mục tiêu đo được, không làm

**Vấn đề.** Skill Lead ghi "Solo: you are the owner" (`skills/apos-lead/SKILL.md:13`), nhưng `lead commit` với plan Solo lại dispatch một phiên Codex **mới** trong worktree mới (`src/cli-app.ts:186` → `src/app/solo.ts:24-45` → `src/runtime/orca.ts:217-230`). Phiên đó không biết những gì Lead đã đọc và cân nhắc khi lập plan (`README.md:368`). Thêm vào đó, Lead do người mở tay nên không phải terminal do APOS dispatch, vì vậy `assertHuman` không chặn được nó (`src/cli-app.ts:70-90`): Lead có thể tự chạy `goal approve` hay `outcome close`.

**Mục tiêu đo được.**

| ID | Mục tiêu | Đo bằng |
| --- | --- | --- |
| M1 | Với mỗi Goal Solo, phiên lập plan và phiên làm là **một**: dispatch trong `execution-started` trùng với dispatch Lead hiện hành | Event log; test `lead-owns-solo` |
| M2 | Mỗi version của một Goal Solo chỉ có đúng một `worker-start --worktree new-top-level` (của Lead); repair và wake đều vào cùng terminal | Test adapter đếm lệnh Orca |
| M3 | Mọi lệnh dành cho người đều bị từ chối khi chạy từ terminal hoặc worktree của Lead, **kể cả trước `lead commit`** | Test `assertHuman` |
| M4 | (Đo, không cam kết) chất lượng Solo so với baseline agent đơn | Chạy lại pilot SQLFMT, so với 28/32 trước đây và 32/32 của baseline |

**Không làm.**
- Không đổi luồng worker và package của Multi-WP. Chỉ đổi nguồn của `leadTerminal`.
- Không đổi gate, review, merge, appetite.
- Không làm controller dừng được một phiên đang chạy (giới hạn của Orca, giữ nguyên).
- Không đổi runtime mặc định. Lead vẫn dùng profile `lead` (`src/runtime/orca.ts:225`).

## 2. Hiện trạng

| Hiện trạng | Phải giữ | Muốn đổi | Chưa xác minh |
| --- | --- | --- | --- |
| `goal select` chỉ ghi `goal-selected` (`src/cli-app.ts:131-134`, `src/domain/transitions.ts:84-86`) | Lệnh dành cho người (`assertHuman`) | Ghi xong thì dispatch Lead | — |
| Không có code nào dispatch Lead trước `lead commit`; Lead do người mở | — | Controller dispatch Lead | Cách anh mở Lead (Q0: giả định mở tay trong repo chính) |
| `lead commit` Solo → `SoloService.start` → `startSolo` → `worker-start --worktree new-top-level` (`src/cli-app.ts:171-188`, `src/app/solo.ts:24-45`, `src/runtime/orca.ts:217-230`) | Ghi intent trước khi dispatch, recover theo key | Solo nhận lại dispatch của Lead, không gọi Orca | — |
| `--terminal` chỉ dùng cho Multi-WP và sinh ra `lead-woken` (`src/cli-app.ts:177`) | Đánh thức theo lô, chỉ khi lượt trước đã xong (`src/app/supervisor.ts:478-500`) | Lấy `leadTerminal` từ dispatch Lead | — |
| `resumeSolo` gửi `worker-start --terminal <ref.terminal> --worktree id:<ref.worktreeId>` (`src/runtime/orca.ts:279-289`) | Giữ nguyên | Ref truyền vào là ref của Lead | — |
| `assertHuman` gom terminal/worktree từ `runtimeRef`, `reviewDispatch`, package, `leadTerminal`, và event `execution-started`/`runtime-resumed`/`package-*` (`src/cli-app.ts:70-90`) | Cơ chế so `ORCA_TERMINAL_HANDLE` và cwd | Thêm event của Lead | — |
| `lead propose` đặt `baseCommit` = HEAD của repo chính (`src/cli-app.ts:151-152`) | Gate so base với delivery | Lấy base của worktree Lead | — |
| CLI lấy repo từ `--repo` hoặc cwd (`src/cli-app.ts:51`); agent ở worktree phải truyền `--repo` | — | Brief Lead nêu `--repo` | Brief worker hiện có nêu `--repo` không (U2) |
| `controller tick` bỏ qua Goal chưa có proposal hoặc không ở `ready/executing/blocked` (`src/app/controller.ts:112-113`) | — | Thêm nhánh "Lead đang lập plan" | — |
| Tick: Solo ở `ready` thì gọi `service.start` (`src/app/controller.ts:142`) | — | `start` chỉ nhận lại ref của Lead | — |
| Solo settle bằng `worker_done` qua `consumeInbox` và `inspect` (`src/app/controller.ts:43-75, 155-162`), rồi `SoloSupervisor.step` chạy gate (`src/app/supervisor.ts:73-160`) | Giữ nguyên | — | — |
| Dispatch wake của Lead được `retainWorker` để terminal còn dùng được (`src/app/controller.ts:47-51`) | Giữ nguyên | Áp dụng thêm cho dispatch đầu của Lead | — |
| Đồng hồ wall time tính từ `execution-started` (`src/app/solo.ts:16-21`, `src/app/supervisor.ts:52-55`) | — | Tính từ `lead-started` (Q2) | — |
| `assertExecutionSettled` chỉ xét `runtimeRef` và package (`src/app/replan.ts:5-15`) | — | Thêm dispatch Lead | — |
| `proposal-drafted/revised` xoá `runtimeRef` (`src/domain/transitions.ts:97-103`) | — | Ref của Lead nằm ở trường riêng, không bị xoá | — |
| `soloBrief` dùng skill `lead`, report `solo-a<n>.md`, có activation line (`src/runtime/brief.ts:69-80`) | Activation line, đường dẫn report | Thêm `leadBrief` | — |
| `applyEvent` không có nhánh `default`: gặp type lạ thì trả `undefined`, và event kế tiếp ném lỗi "Goal does not exist" (`src/domain/transitions.ts:64-74`). Replay chạy ở `journal.ts:85,124`, `sqlite.ts:20,44`, `readonly-journal.ts:30` | — | Bản chuẩn bị: bỏ qua type lạ (mục 7) | — |
| Commit mốc của APOS (tác giả `apos@local.invalid`, `src/store/project-history.ts:98`) được ghi vào repo chính ở các mốc như plan accepted (`src/store/journal.ts:85-88`). `foreignCommits` chỉ xét `evidence/` và bỏ qua commit của tác giả APOS (`src/app/supervisor.ts:283-287`) | Bỏ qua commit mốc | — | — |
| `startPackage` lấy base = HEAD của repo chính lúc dispatch (`src/runtime/orca.ts:233-235`); `packageBrief` đọc `execution.md` và `packages/<id>.md` (`src/runtime/brief.ts:99`), các file này chỉ có sau commit mốc | Giữ nguyên | — | Lead integrate trong worktree riêng (U6) |

## 3. Ràng buộc đã chốt

**Của anh** (đồng ý đề xuất, 2026-11-14):
- **Q0:** Hiện Lead được mở tay trong repo chính. *(giả định, anh không bổ sung nguồn)*
- **Q1:** `goal select` dispatch Lead ngay. Nếu Orca không trả lời rõ thì `controller tick` recover theo key.
- **Q2:** Đồng hồ appetite chạy từ lúc dispatch Lead. Thời gian và token lập plan tính vào appetite, và `estimatedCost` phải gồm cả phần lập plan.
- **Q3:** Bỏ luồng "Solo dispatch phiên mới". `lead commit` Solo từ chối nếu Goal không có dispatch Lead.
- **Q4:** Lead kết thúc lượt mà chưa có plan được chấp nhận thì controller báo `needs-decision`, giữ lại terminal. Sau khi người quyết, Lead được đánh thức trên **cùng** terminal.

**Lựa chọn của em:**
- Lượt đầu của Lead (lập plan và làm) là attempt 1. Report vẫn ở `solo-a1.md`. Lý do: repair và đếm attempt không phải đổi.
- `baseCommit` của proposal là base của worktree Lead. Proposal nêu base khác thì bị từ chối. Lý do: gate phải so đúng commit mà Lead đã đọc.
- `lead propose` và `lead commit` chỉ nhận lệnh từ terminal Lead hiện hành (`ORCA_TERMINAL_HANDLE`). Lý do: nếu không, owner được nhận lại có thể không phải phiên đã lập plan, tức quay lại đúng lỗi đang sửa.
- Thêm lệnh `lead start <id>` (cho người) để dispatch lại Lead, phục vụ chuyển đổi và trường hợp Orca từ chối rõ ràng. Thêm lệnh `lead wake <id> --note` (dành riêng cho người) cho Q4. Lý do: quyết định của người ở Q4 có nhiều dạng (đổi appetite, trả lời câu hỏi…), nên một lệnh rõ ràng dễ kiểm soát hơn việc tự đoán từ event.
- `controller tick` chỉ **recover** intent dispatch Lead còn treo, không tự khởi tạo Lead cho những Goal đã `selected` từ trước. Lý do: tránh đè lên một Lead đang được mở tay lúc nâng cấp.

**Giả định:** Orca giữ ngữ cảnh hội thoại khi `worker-start --terminal` gửi vào một Codex terminal đang chạy. Điều này đã được xác nhận khi chạy live với resume Solo (`README.md:362-364`).

## 4. Phương án và so sánh

| Thước đo | **A. Controller dispatch Lead; Solo nhận lại dispatch đó** | B. Lead mở tay; `lead commit --terminal` giao việc cho terminal đó | C. Giữ owner mới, truyền thêm ngữ cảnh plan qua tài liệu |
| --- | --- | --- | --- |
| Giữ ngữ cảnh lập plan | Có, cùng một phiên | Có | Không, chỉ giữ được phần viết ra |
| Worktree riêng | Có, từ lúc dispatch | Không: Lead ở repo chính nên commit vào managed checkout (`foreignCommits` sẽ chặn, `src/app/supervisor.ts:127-128`) | Có |
| `assertHuman` chặn Lead | Có, từ lúc dispatch | Chỉ sau `lead commit`; lúc lập plan vẫn hở | Không |
| Dispatch ID để theo dõi settle và telemetry | Có | Gửi vào terminal đang bận chính lệnh `lead commit` nên Orca từ chối hoặc phải xếp hàng | Có |
| Khối lượng đổi | Vừa: transitions, `select`, `lead commit/propose`, tick, adapter, brief, skill | Vừa, và phải xử lý terminal bận | Nhỏ: brief, skill |
| Đảo ngược được không | Được trước khi có event mới (mục 7) | Được | Được |
| Công bảo trì | Bỏ được một luồng (dispatch owner Solo) | Thêm một luồng | Không đổi |

**Chọn A.** B không giải quyết được worktree và `assertHuman`. C rẻ nhất nhưng không chạm vào nguyên nhân: phần ngữ cảnh mất nằm ở những gì Lead đã đọc trong code, không viết ra hết được.

## 5. Quyết định

### 5.1 Luồng

```text
Người: goal select GOAL-1
  └─ ghi goal-selected
  └─ ghi lead-dispatch-intended{key}
  └─ Orca: run-create "APOS GOAL-1 lead v<goalVersion> key <key>"
           worker-start --worktree new-top-level --base-branch <HEAD> --agent/model theo profile lead
                        --spec leadBrief
  └─ ghi lead-started{ref: runId, dispatchId, terminal, worktreeId, baseCommit, requested}

Lead (trong worktree riêng): đọc goal và code
  └─ apos --repo <managed> lead propose   (baseCommit = ref.baseCommit)
  └─ apos --repo <managed> lead commit    (từ chối nếu ORCA_TERMINAL_HANDLE ≠ lead terminal)
       ├─ Solo: proposal-approved → execution-started{ref = dispatch Lead hiện hành}  (không gọi Orca)
       │        Lead làm tiếp trong cùng lượt → commit solo-a1.md → worker_done
       │        → worker-settled → gate (như hiện nay) → đỏ: resumeSolo vào cùng terminal
       └─ Multi-WP: proposal-approved → lead-woken{events: [], dispatchId: dispatch Lead, terminal, worktree, runId}
                    → dispatch package (như hiện nay) → Lead worker_done, kết thúc lượt
                    → các lần wake sau vào cùng terminal (logic hiện có)

Lead kết thúc lượt trước khi plan được chấp nhận (Q4):
  └─ tick: lead-settled{dispatchId, outcome} → retainWorker → human-notified{kind: 'lead-needs-decision'}
  └─ Người quyết rồi chạy: apos lead wake GOAL-1 --note "..."
  └─ Orca: worker-start --terminal <lead> --worktree id:<lead> --spec leadResumeBrief(note) → lead-woken{dispatchId,...}
```

"Dispatch Lead hiện hành" là dispatch mới nhất trong số `lead-started.ref.dispatchId` và các `lead-woken.dispatchId` của version Goal hiện tại.

### 5.2 Dữ liệu (event và state)

| Event mới | Dữ liệu | Điều kiện | Hiệu ứng lên state |
| --- | --- | --- | --- |
| `lead-dispatch-intended` | key | `selected`, chưa có `leadIntent`, chưa có Lead đang chạy | `leadIntent = key` |
| `lead-started` | `RuntimeRef` (có `terminal`, `worktreeId`, `baseCommit`, `requested`) | có `leadIntent`, hoặc là recover theo key | `lead = {ref, goalVersion}`, xoá `leadIntent`, `leadTerminal = {terminal, worktree: id:<worktreeId>, runId}` |
| `lead-settled` | `dispatchId`, `outcome` | Goal ở `selected` hoặc `planned`, dispatch là dispatch Lead hiện hành | đánh dấu Lead đã xong lượt; không đổi status |

Event có sẵn, đổi điều kiện:
- `intent-abandoned`: xử lý thêm trường hợp `leadIntent`.
- `execution-started` (Solo): thêm điều kiện `data.dispatchId` phải là dispatch Lead hiện hành.
- `lead-woken`: dùng được cả khi Goal đang ở `selected/planned` (Q4).
- `goal-revised`, `outcome-revised`: xoá `lead`, `leadIntent`, `leadTerminal` vì version mới cần Lead mới (U4).
- `proposal-drafted/revised`: **không** xoá `lead`.

### 5.3 Interface

| Thành phần | Thay đổi |
| --- | --- |
| `goal select <id>` | Sau khi ghi `goal-selected`, gọi `LeadService.start`. Orca lỗi thì select vẫn có hiệu lực, in lỗi và cách thử lại. Có Lead đang chạy thì không dispatch lần nữa. |
| `lead start <id>` (mới, người) | Dispatch Lead cho Goal `selected` chưa có Lead đang chạy. Dùng khi chuyển đổi hoặc sau khi Orca từ chối. |
| `lead wake <id> --note <text>` (mới, chỉ người) | Đánh thức Lead đã `lead-settled` trên cùng terminal, kèm quyết định của người. |
| `lead propose` | `baseCommit` mặc định lấy từ `lead.ref.baseCommit`; proposal nêu base khác thì từ chối. Chỉ nhận từ terminal Lead. |
| `lead commit <id>` | Chỉ nhận từ terminal Lead. Solo: `SoloService.adopt` thay cho `start`. Multi-WP: tự ghi `lead-woken` từ ref của Lead; `--terminal` không cần nữa (vẫn nhận nhưng phải khớp, nếu không thì từ chối). |
| `RuntimeAdapter.startLead(input)` (mới) | Giống `startSolo` nhưng dùng `leadBrief` và objective `lead`. `startSolo` bị bỏ. |
| `leadBrief` (mới, `src/runtime/brief.ts`) | WORKSPACE, `skillLines(lead)`, contract `goal.md` và `source.md` tại base (**không** nhắc `execution.md`: file này chỉ có sau commit mốc, tức sau base của Lead; plan là do chính Lead viết), hướng dẫn `apos --repo <managed> lead propose/commit`, "Solo: sau khi commit được chấp nhận, làm luôn trong lượt này và commit `solo-a1.md`", "Multi-WP: dispatch xong thì `worker_done` và kết thúc lượt", budget line, repo marker, dispatch key, base commit. |
| `leadResumeBrief` (mới) | Quyết định của người, nhắc lại bước tiếp theo theo skill. |
| `assertHuman` | Thêm terminal/worktree từ `lead-started` và `lead-woken`. |
| `assertExecutionSettled` | Thêm dispatch Lead hiện hành. |
| `ControllerService.tick` | Nhánh mới cho Goal `selected/planned` có `lead` hoặc `leadIntent`: recover intent; `inspect` dispatch Lead; settle thì ghi `lead-settled`, retain, báo người; idle thì báo `lead-idle`; vượt wall time thì báo `overrun`. |
| Đồng hồ (`solo.ts budget`, `supervisor.wallMinutesUsed`, telemetry) | Mốc là `lead-started` (Q2); không có thì lùi về `execution-started`. |
| `skills/apos-lead/SKILL.md` | Bước 3 và 5: không còn cờ `--terminal`; Solo: "sau khi `lead commit` được chấp nhận, tiếp tục làm trong cùng lượt, không kết thúc lượt"; Multi-WP: kết thúc lượt sau khi dispatch. Skill thay đổi nên dự án phải chạy lại `init`. |
| UI (read-model, story) | Hiện Lead như một dispatch (role `lead`) từ `lead-started`. Transcript tự khớp theo worktree path. |

### 5.4 Bất biến

- **I1.** Với mỗi version Goal, có nhiều nhất một Lead đang chạy (một `lead`, hoặc một `leadIntent`).
- **I2.** Ở Solo, owner chính là dispatch Lead hiện hành. Không có `worker-start --worktree new-top-level` nào khác cho Goal đó, trừ reviewer.
- **I3 (Solo).** `proposal.baseCommit` = `lead.ref.baseCommit` = `runtimeRef.baseCommit`. Multi-WP không áp dụng: package vẫn lấy base = HEAD của repo chính lúc dispatch, vì brief package cần `execution.md` và `packages/<id>.md` có trong commit mốc. Đặt base của package bằng base của Lead sẽ làm mất các file đó.
- **I4.** Terminal và worktree của Lead nằm trong tập mà `assertHuman` chặn, kể từ `lead-started`.
- **I5.** Chỉ terminal Lead hiện hành mới chạy được `lead propose/commit` cho Goal đó.
- **I6.** Đồng hồ appetite có đúng một mốc bắt đầu cho mỗi version Goal.

## 6. Failure modes và quan sát

| # | Tình huống | Bất biến giữ | Phát hiện | Ai xử lý |
| --- | --- | --- | --- | --- |
| F1 | Orca không trả lời rõ khi dispatch Lead lúc `goal select` | I1 | `leadIntent` còn treo; tick gọi `recover(key)`. Sau 10 phút vẫn không rõ thì báo `needs-decision` (cùng mẫu với `src/app/controller.ts:146-153`) | Người: kiểm `orca orchestration task-list`, rồi `execution abandon-intent` hoặc `lead start` |
| F2 | Orca từ chối rõ ràng (`OrcaRefused`) | I1 | Ghi `intent-abandoned`, in lỗi | Người: sửa cấu hình, chạy `lead start` |
| F3 | Lead chết ngay lúc khởi động (sai model, auth) | — | Tick ở pha lập plan: `inspect` idle ≥ `OWNER_IDLE_MINUTES` thì báo `lead-idle` một lần (theo mẫu `noticeIdleOwner`) | Người |
| F4 | Lead kết thúc lượt mà chưa có plan được chấp nhận (Q4) | I1, I5 | `lead-settled` → `human-notified{lead-needs-decision}` → terminal được retain | Người quyết, rồi `lead wake` |
| F5 | Người hoặc agent khác chạy `lead propose/commit` từ terminal khác | I5 | Lệnh bị từ chối, thông báo nêu terminal đúng | — |
| F6 | Lead tự chạy lệnh dành cho người | I4 | `assertHuman` từ chối, exit 1 | — |
| F7 | Main tiến lên trong lúc Lead lập plan | I3 | Proposal có base khác thì bị từ chối; gate so với base của worktree Lead; post-merge gate (có sẵn) bắt xung đột khi merge | Lead / người khi merge |
| F8 | Lead commit nhầm vào repo chính (vì dùng `--repo`) | — | `foreignCommits` có sẵn → `needs-decision` (`src/app/supervisor.ts:127-128`) | Người |
| F9 | Lead kết thúc lượt ngay sau `lead commit` Solo mà không làm | I2 | Settle không có report → finding `no-report` → resume cùng Lead (có sẵn, `src/app/supervisor.ts:131-134`) | Controller |
| F10 | Revise Goal (`intent_gap`) khi Lead còn đang chạy | I1 | `assertExecutionSettled` từ chối cho tới khi Lead xong lượt | Lead ghi finding rồi kết thúc lượt; người revise |
| F11 | Chạy `goal select` hai lần, hoặc tick chạy song song với select | I1 | Transition `lead-dispatch-intended` từ chối khi đã có intent hoặc Lead | — |
| F12 | Vượt wall time ngay trong pha lập plan | I6 | Tick ở pha lập plan báo `overrun` một lần; `proposal-approved` kiểm `estimatedCost` so với phần appetite còn lại | Người: `goal appetite` hoặc `outcome stop` |
| F13 | Multi-WP: wake đầu tiên tới khi Lead còn đang chạy sau `lead commit` | — | `lead-woken` đầu tiên mang dispatchId của Lead nên logic "Lead busy" (`src/app/supervisor.ts:486-492`) giữ lại sự kiện | Controller |
| F14 | Mất phản hồi khi chạy `lead wake` | — | Ghi intent trước (key), tick recover như F1 | Người |
| F15 | Commit mốc "plan accepted" của APOS nằm trên repo chính, sau base của Lead | I3 | Không phải lỗi: `foreignCommits` bỏ qua commit của tác giả `apos@local.invalid` (`src/app/supervisor.ts:283-287`); delivery của Lead chỉ sửa `evidence/` nên merge không đụng `execution.md`. Có test khẳng định điều này | — |

**Quan sát.** Không thêm metric mới. Các tín hiệu đi qua `apos inbox` và UI ("Needs you"):

| Notice | Điều kiện | Người nhận | Khi không có ai trực |
| --- | --- | --- | --- |
| `needs-decision` (F1) | Intent Lead không rõ quá 10 phút | Người, qua inbox | Goal đứng yên ở `selected`; không có tác dụng phụ |
| `lead-idle` (F3) | Lead chưa xong lượt, idle ≥ ngưỡng | Người | Không tốn thêm token; đồng hồ appetite vẫn chạy |
| `lead-needs-decision` (F4) | `lead-settled` khi chưa có plan được chấp nhận | Người | Goal đứng yên; terminal được giữ |
| `overrun` (F12) | Wall time vượt appetite ở pha lập plan | Người | Lead vẫn chạy (không dừng được, giới hạn hiện có) |

## 7. Chuyển đổi

**Migration.** Không có migration dữ liệu: các event mới chỉ được thêm vào. Goal ở trạng thái cũ được xử lý như sau:
- `executing`, `verified`, `closed`: không đổi, `runtimeRef` cũ vẫn dùng được.
- `selected`/`planned` chưa có `lead`: `lead commit` Solo từ chối và hướng dẫn người chạy `lead start <id>`. Lead mở tay cũ phải dừng. Plan đã propose bị bỏ, Lead mới propose lại (`proposal-revised` tăng version).
- `ready` (đã commit plan nhưng chưa dispatch theo luồng cũ): `adopt` không có Lead nên tick báo `needs-decision`. Người chạy `lead start`; Lead mới propose lại.

**Thứ tự rollout** (mỗi bước có test và đều xanh mới sang bước sau):
0. **Bản chuẩn bị, phát hành riêng:** `applyEvent` bỏ qua type lạ (trả lại state cũ, ghi cảnh báo) thay vì trả `undefined`. Đây là điều kiện để rollback ở dưới không phá log.
1. Transitions và các event mới, kèm test bất biến I1–I6.
2. `startLead`, `leadBrief`, `leadResumeBrief` trong adapter, kèm test đếm lệnh Orca (M2).
3. `goal select`, `lead start`, `lead wake`, `lead propose` (base), `lead commit` (adopt và multi), `assertHuman`, `assertExecutionSettled`. Các test CLI và fault-injection hiện đang gọi `lead commit` mà không có `ORCA_TERMINAL_HANDLE` phải được thêm fixture `lead-started` và terminal tương ứng (vì I5).
4. Nhánh pha lập plan trong `controller tick`, đổi mốc đồng hồ, telemetry role `lead`.
5. Skill `apos-lead`, README (bỏ dòng `README.md:368`, cập nhật Quick start và CLI reference), UI.
6. Chạy live trên Orca và Codex: (a) Solo sạch, (b) Solo gate đỏ rồi repair trên cùng terminal, (c) Q4: đặt appetite thấp để `lead commit` bị từ chối, người chạy `goal appetite` rồi `lead wake`, (d) Multi-WP toy.
7. Đo M4: chạy lại SQLFMT.

**Điểm dừng.** Sau bước 3, nếu test live (6a) cho thấy Orca không giữ ngữ cảnh khi gửi vào terminal đang mở (sai giả định ở mục 3) thì dừng và xem lại phương án.

**Rollback.**
- Trước khi bất kỳ project nào có `lead-started`: revert về bản chuẩn bị (bước 0) hoặc cũ hơn, chạy lại `init` để lấy skill cũ.
- Sau khi đã có event mới: **chỉ rollback về bản chuẩn bị (bước 0)**. Bản đó bỏ qua event lạ, nên Goal vẫn replay được, nhưng một Goal Solo đang ở pha Lead thì không còn ai quản (Lead vẫn chạy, controller cũ không biết). Người dừng Goal đó bằng `outcome stop` rồi tạo lại.
- **Không được** rollback về code trước bước 0 khi log đã có event mới. `applyEvent` cũ trả `undefined` với type lạ nên event kế tiếp ném lỗi, và việc dựng lại index (`journal.ts:83`) sẽ lỗi cho cả project, không chỉ Goal đó. `outcome stop` không cứu được vì event cũ vẫn còn trong log. Ghi rõ điều này trong commit message và README.

## 8. Điều chưa chắc

| ID | Câu hỏi | Cách xác minh | Ai quyết | Chặn? |
| --- | --- | --- | --- | --- |
| U1 | Orca có nhận `worker-start --terminal` khi terminal Lead đã settle và đã được retain từ lượt trước không (Q4, `lead wake`)? | Đã thấy live với wake của Multi-WP (`src/app/controller.ts:47-51`); kiểm lại ở bước 6c | Em | Không |
| U2 | Brief và skill worker hiện có nêu `--repo` không? Có nên để CLI tự suy ra repo chính từ worktree (`git rev-parse --git-common-dir`) không? | Đọc `skills/apos-worker`, `skills/apos-core`; thử ở bước 6a | Em đề xuất, anh duyệt nếu đổi CLI | Không (brief nêu `--repo` là đủ) |
| U3 | ~~Code cũ gặp event lạ thì sao?~~ **Đã xác minh:** trả `undefined`, event kế tiếp ném lỗi (`src/domain/transitions.ts:64-74`). Đã xử lý bằng bước 0 ở mục 7 | — | — | — |
| U6 | Multi-WP: Lead giờ integrate (`git merge --no-ff`) trong worktree riêng thay vì repo chính. `integration complete` chỉ kiểm commit package là ancestor (`src/app/integration.ts:33`) nên có lẽ không phụ thuộc chỗ merge, nhưng worktree Lead có base cũ hơn base của package | Đọc hết `src/app/integration.ts`; kiểm ở bước 6d | Em | Không với Solo; chặn phần Multi-WP của bước 6 nếu sai |
| U4 | Sau `goal-revised` (intent_gap), nên dispatch Lead mới hay đánh thức Lead cũ để giữ ngữ cảnh? | Thiết kế này chọn Lead mới (đơn giản, contract đã đổi). Có thể cân nhắc lại sau pilot | Anh | Không |
| U5 | Lead có lẽ sẽ tốn nhiều token hơn owner mới (vì mang ngữ cảnh plan). Có phải điều chỉnh appetite mặc định không? | Telemetry ở bước 6–7 | Anh | Không |

## 9. Bàn giao

**Nguồn cho `spec-to-dev-tasks`:** file này (mục 5 và 6), cùng các vị trí code ở mục 2.

**Việc cần kiểm chứng** (mỗi bất biến có ít nhất một phép thử):

| Bất biến | Phép thử |
| --- | --- |
| I1 | Gọi `goal select` hai lần và tick song song: chỉ có một `lead-dispatch-intended` và một `worker-start` |
| I1, F1 | Adapter giả trả lỗi không rõ khi `startLead`: `leadIntent` còn; tick `recover` ra ref thì ghi `lead-started`; không ra thì sau 10 phút có `needs-decision` |
| I2, M1, M2 | Luồng Solo đầy đủ trên adapter giả: dispatch trong `execution-started` trùng dispatch của `lead-started`; đếm đúng 1 `worker-start --worktree new-top-level` (chưa tính reviewer); gate đỏ thì `resumeSolo` vào cùng terminal |
| I3, F7 | Đổi HEAD của repo chính sau `lead-started`, rồi `lead propose`: base = base của Lead; proposal nêu base khác thì bị từ chối |
| I4, M3, F6 | Đặt `ORCA_TERMINAL_HANDLE` = terminal Lead (và cwd = worktree Lead) **trước** `lead commit`: `goal approve`, `outcome close`… đều exit 1 |
| I5, F5 | `lead commit` từ terminal khác: bị từ chối; từ terminal Lead: được nhận |
| I6, F12 | Mốc đồng hồ là `lead-started`; vượt wall time ở pha lập plan thì có một notice `overrun` |
| F4, U1 | Lead settle khi đang `planned`: có `lead-settled`, retain, notice; `lead wake` gửi vào cùng terminal và ghi `lead-woken` |
| F9 | Lead settle sau `lead commit` Solo mà không có report: finding `no-report`, resume cùng terminal |
| F10 | `goal revise` khi Lead còn đang chạy: bị từ chối; sau khi Lead settle: được nhận và xoá `lead` |
| F13 | Multi-WP: `lead commit` ghi `lead-woken` mang dispatch Lead; sự kiện package tới khi Lead còn bận thì bị giữ lại |
| Live | Bước 6 (a–d) trên Orca thật; ghi log vào `docs/fault-injection.md` các ca mới |
