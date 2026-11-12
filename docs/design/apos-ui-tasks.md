# [TASK] APOS UI: bảng điều khiển web local chỉ xem

Trạng thái: Ready — làm được ngay: BE-1, BE-2, BE-3, BE-4, FE-1, QA-1 (theo thứ tự phụ thuộc ở mục 5). Ba câu hỏi còn mở đều **không chặn**.

## THÔNG TIN CHUNG
- Mã task đề xuất: cần cấp mã.
- Loại / ưu tiên: tính năng mới; ưu tiên cần PM xác định.
- Phạm vi tác động: thêm `src/ui/`, lệnh `apos ui`; sửa nhẹ `src/cli-app.ts` (rút inbox) và `src/store/event-log.ts` (đường đọc không ghi). Không đổi schema, không đổi hành vi ghi.
- Nguồn thiết kế: `docs/design/apos-ui.md` (Đã duyệt 2026-11-12). File này chia việc từ đó.

## 1. BỐI CẢNH & MỤC TIÊU
**Hiện trạng (có bằng chứng):**
- Human chỉ xem APOS qua CLI; `goal list` và `inbox` in text tab (`src/cli-app.ts:111`, `:396-402`). Không có HTTP server trong `src/`.
- Trạng thái Goal là kết quả gập (fold) các event bằng hàm `applyEvent` (`src/store/sqlite.ts:18-20`); hàm này gọi độc lập được, `importLegacy` cũng dùng nó (`src/store/journal.ts:~117`). `GoalState` đã có `telemetry` (`src/domain/transitions.ts:366-369`), `appetite`, `packages`, `gate`, `reviews`.
- Interface `GoalRepository` (`journal.ts:10-20`: `getGoal`, `listGoals`, `events`) là điểm cắm để viết reader chỉ đọc.

**Mục tiêu:** M1–M5 như `docs/design/apos-ui.md` mục 1.

## 2. PHẠM VI & NON-GOALS
- Làm: v1 chỉ xem, web local, một repo, poll 3 giây (đều do PM chốt: Q1–Q7).
- Không làm: nút ghi, điều khiển controller, nhiều người dùng, đăng nhập, truy cập ngoài localhost, nhiều project.

## 3. YÊU CẦU & ACCEPTANCE CRITERIA

- **REQ-01 Khởi động:** `apos ui [--port <n>]` mở server HTTP chỉ nghe `127.0.0.1` và in URL.
  - **AC-01 (REQ-01):** Given repo đã `init`, When chạy `apos ui --port 4300`, Then process in `http://127.0.0.1:4300` và `GET /` trả trang HTML 200.
  - **AC-02 (REQ-01):** Given port 4300 đang bị dùng, When chạy `apos ui --port 4300`, Then thoát với exit code ≠ 0 và thông báo nêu port bị chiếm.
  - **AC-03 (REQ-01):** Given server đang chạy, When kết nối tới địa chỉ không phải loopback của máy, Then không kết nối được.

- **REQ-02 Chỉ đọc tuyệt đối:** UI không thay đổi controller home.
  - **AC-04 (REQ-02):** Given controller home có `events/*.jsonl`, `state.sqlite`, `sources/`, `artifacts/`, When gửi 100 request tới mọi route GET, Then hash toàn bộ thư mục trước và sau bằng nhau.
  - **AC-05 (REQ-02):** Given một file `events/GOAL-X.jsonl` có dòng cuối chưa hoàn chỉnh (không kết thúc bằng `\n`), When UI đọc Goal đó, Then file không bị cắt (byte không đổi) và dòng cuối dở bị bỏ qua khi hiển thị.
  - **AC-06 (REQ-02):** Given server đang chạy, When gửi `POST`, `PUT`, `PATCH` hay `DELETE` tới bất kỳ route, Then trả 405.

- **REQ-03 Hàng đợi "Cần anh":** nêu mọi việc cần Human.
  - **AC-07 (REQ-03):** Given bộ event có Goal `blocked`, Goal `verified` và event `human-notified`, When so kết quả `buildInbox` với đầu ra `apos inbox`, Then cùng các mục `needs-decision`, `awaiting-outcome`, `notice` (cùng Goal, cùng nội dung).
  - **AC-08 (REQ-03):** Given Goal `draft`, When xem Inbox trên UI, Then có mục "chờ cổng A (duyệt Goal)" cho Goal đó. Mục này chỉ có ở UI (CLI `inbox` không in).
  - **AC-09 (REQ-03):** Given Goal `approved`, When xem Inbox, Then có mục "chờ cổng B (chọn Goal)".
  - **AC-10a (REQ-03):** UI không hiện notice của Goal `closed` hoặc `stopped`, và không hiện notice `awaiting-outcome` khi Goal đang `verified` (đã có mục từ trạng thái). CLI `apos inbox` vẫn liệt kê đủ. (PM duyệt 2026-11-12)
  - **AC-10 (REQ-03):** Mỗi mục Inbox hiện Goal, lý do và tuổi chờ tính từ event gây ra mục đó.

- **REQ-04 Bảng Goal nhóm theo ai giữ việc:**
  - **AC-11 (REQ-04):** Mỗi Goal nằm đúng một nhóm theo bảng: Anh = `draft, approved, blocked, verified`; Lead = `selected, planned`; Controller/agent = `ready, executing`; Xong = `closed, stopped` (thu gọn mặc định). (Theo mặc định Q-C)
  - **AC-12 (REQ-04):** Mỗi dòng Goal hiện id, outcome, mode (Solo/Multi-WP, trống nếu chưa có proposal), tiến độ package `verified/tổng`, chi phí so với appetite, tuổi từ event cuối.

- **REQ-05 Chi tiết Goal:**
  - **AC-13 (REQ-05):** Given Goal Multi-WP, When mở chi tiết, Then thấy đồ thị package: nút theo trạng thái (`specified, dispatching, resuming, executing, blocked, verified, stale`), mũi tên theo phụ thuộc.
  - **AC-14 (REQ-05):** Chi tiết hiện stepper vòng đời, finding, từng lần gate (check, commit, kết quả) với link log, review, telemetry theo dispatch (model, token vào/cache/ra, wall time; `unknown` hiện là `unknown`, không ước lượng), appetite và mức đã dùng.
  - **AC-15 (REQ-05):** Tab Timeline hiện tối đa 200 event gần nhất, có phân trang để xem cũ hơn.
  - **AC-16 (REQ-05):** `GET /api/goals/<id>/gate-log/<logId>` và `/source/<version>` chỉ trả nội dung khi `id` khớp `GOAL-[A-Z0-9-]+`, `version` là số nguyên, `logId` thuộc danh sách log của Goal đó; ngược lại 400 hoặc 404.

- **REQ-06 Dải trạng thái:**
  - **AC-17 (REQ-06):** Luôn hiện thời điểm đọc gần nhất (`readAt`), tuổi của event cuối trong repo, và "controller đang chạy một tick" khi `controller.lease` tồn tại với pid còn sống. (Theo mặc định Q-B)
  - **AC-18 (REQ-06):** UI **không** kết luận "controller đã dừng" chỉ vì không có lease (lease chỉ tồn tại trong lúc một tick chạy: `src/store/lease.ts:13-27`).

- **REQ-07 Bảo mật local:**
  - **AC-19 (REQ-07):** Request có `Host` khác `127.0.0.1:<port>` hoặc `localhost:<port>` bị trả 403.
  - **AC-20 (REQ-07):** Đường dẫn chứa `..`, `%2F` hay id sai định dạng không bao giờ đọc file ngoài controller home.

- **REQ-08 Hiển thị an toàn và lỗi trung thực:**
  - **AC-21 (REQ-08):** Given outcome/note/log chứa `<script>alert(1)</script>`, When render, Then hiện thành văn bản, không thực thi.
  - **AC-22 (REQ-08):** Given chuỗi hash của một Goal bị đứt (sửa một dòng), When tải snapshot, Then Goal đó hiện cảnh báo, các Goal khác vẫn hiển thị bình thường.
  - **AC-23 (REQ-08):** Given lỗi đọc, When poll, Then banner đỏ hiện `readAt` của lần thành công gần nhất; dữ liệu cũ không hiện như dữ liệu mới.

- **REQ-09 Tự làm mới:**
  - **AC-24 (REQ-09):** Trang gọi `/api/snapshot` mỗi 3 giây; khi tab ẩn thì tạm dừng.

## 4. TỔNG QUAN KỸ THUẬT

**Đã xác minh (từ code):**
- `EventLog.lines()` cắt dòng cuối dở bằng `truncateSync` ngay trong đường đọc (`src/store/event-log.ts:34-38`) và constructor `mkdirSync` (`:26`). `ProjectJournal` constructor còn `rebuildIndex` ghi sqlite dưới `withLock` (hạn 15 giây, `src/store/project-history.ts:39-47`). Nên **không** dùng `ProjectJournal.open` cho UI. (U1 xác nhận)
- `applyEvent(state, event)` thuần, gập từ `undefined` (`src/store/sqlite.ts:20`): reader chỉ đọc dựng được trạng thái mà không qua sqlite. (U2 xác nhận)
- `ready` được đặt khi controller chấp nhận plan của Lead (`proposal-approved`, `transitions.ts:~118`, ghi chú "The controller, not the Human, accepts the Lead's plan"). Vậy `ready` thuộc nhóm Controller. (U3 xác nhận)
- `controller.lease` chỉ tồn tại trong lúc một tick chạy và bị xoá ngay sau (`lease.ts:20-23`). Không phải tín hiệu "controller còn sống". (U4: **khác với giả định của design doc mục 6**, xem mục 7)
- `MetricsService.show` chỉ trả `attempts, blockers, reviewChanges, cycleTimeMs` (`src/app/metrics.ts:3-12`), không có token. Telemetry token nằm ở `state.telemetry` (`transitions.ts:366-369`; do `supervisor.ts:225` ghi).
- Inbox CLI chỉ có 3 loại: `needs-decision` (blocked), `awaiting-outcome` (verified), `notice` (`cli-app.ts:396-402`). Cổng A (`draft`) và B (`approved`) không có trong inbox CLI.

**Đề xuất:**
- `src/app/inbox.ts`: `buildInbox(repo: GoalRepository)` trả mảng `{goalId, kind, detail, at}`; CLI in lại đúng định dạng cũ từ mảng này. UI thêm hai loại `awaiting-approval` (draft) và `awaiting-selection` (approved) ở read-model, không đưa vào CLI.
- `src/store/readonly-journal.ts`: `ReadOnlyJournal implements GoalRepository`; đọc `events/*.jsonl` không `mkdir`, không `truncate`, không lock, không sqlite; dòng cuối không có `\n` thì bỏ qua; vẫn kiểm chuỗi hash (đứt thì ném lỗi theo từng Goal, không làm hỏng Goal khác). Tách hàm kiểm chuỗi dùng chung với `EventLog` để không có hai bản logic hash. `append` ném lỗi.
- `src/ui/read-model.ts`: `buildSnapshot(repo)` và `buildGoalDetail(repo, id, {limit, before})`, hàm thuần trên `GoalRepository`.
- `src/ui/server.ts`: `node:http`, route: `GET /`, `/api/snapshot`, `/api/goals/:id`, `/api/goals/:id/gate-log/:logId`, `/api/goals/:id/source/:version`. Kiểm `Host`, chỉ GET (còn lại 405), `127.0.0.1`.
- `src/ui/page.ts`: trang HTML + JS thuần trong một chuỗi (để `tsc` tự build).
- Hợp đồng JSON `GET /api/snapshot`: `{ readAt, lastEventAt, tickRunning, inbox:[{goalId,kind,detail,at}], goals:[{id,outcome,status,holder,mode,packages:{verified,total},appetite,spendUsd?,lastEventAt,integrityError?}] }`. `integrityError` có khi chuỗi hash đứt. Đây là điểm FE và BE thống nhất; FE dùng fixture JSON theo hợp đồng này để làm song song.
- Các trường ngày giờ ISO 8601; FE chuyển sang múi giờ máy.

## 5. CÔNG VIỆC FE / BE / QA

| Task | Role | Deliverable | REQ / AC | Phụ thuộc (task; Qx + loại) | Trạng thái |
|---|---|---|---|---|---|
| BE-1 | BE | Rút `buildInbox` ra `src/app/inbox.ts`; CLI `inbox` in y như cũ (`cli.test.ts` giữ nguyên) | REQ-03 / AC-07 | — | Làm được ngay |
| BE-2 | BE | `ReadOnlyJournal` + hàm kiểm hash dùng chung với `EventLog`; không side effect | REQ-02, REQ-08 / AC-04, AC-05, AC-22 | — | Làm được ngay |
| BE-3 | BE | `read-model.ts` (snapshot, chi tiết, bảng ánh xạ holder, timeline phân trang, telemetry, appetite, tick đang chạy) | REQ-03..06 / AC-07..18 | BE-1, BE-2; Q-B không chặn; Q-C không chặn | Làm được ngay |
| BE-4 | BE | `server.ts` + lệnh `apos ui` (bind loopback, Host check, 405, id/path an toàn, báo port bận) | REQ-01, REQ-07 / AC-01..03, AC-06, AC-16, AC-19, AC-20 | BE-3; Q-A không chặn | Làm được ngay |
| FE-1 | FE | `src/ui/page.ts`: dải trạng thái, Inbox, bảng nhóm theo holder, chi tiết Goal (stepper, đồ thị package, finding, gate, review, telemetry, timeline), banner lỗi, poll 3 giây, escape toàn bộ dữ liệu | REQ-04..06, REQ-08, REQ-09 / AC-10..15, AC-17, AC-18, AC-21..24 | Hợp đồng JSON mục 4 (làm song song bằng fixture); BE-4 để chạy thật; Q-B, Q-C không chặn | Làm được ngay |
| QA-1 | QA | Bộ test T1–T7 của design doc: ánh xạ ở mục 6 | tất cả AC | BE-1..4, FE-1 | Làm được ngay (viết dần theo từng task) |

## 6. KỊCH BẢN KIỂM THỬ QA

- **TC-01 (AC-07):** Dựng fixture có Goal blocked, verified, notice → chạy `apos inbox` và `buildInbox`; kết quả cùng bộ mục.
- **TC-02 (AC-08, AC-09):** Goal `draft` và `approved` → snapshot có mục `awaiting-approval` / `awaiting-selection`; `apos inbox` không in hai mục này.
- **TC-03 (AC-04, AC-05):** Chụp hash controller home (kể cả file jsonl có dòng cuối cụt) → 100 request mọi route → hash không đổi, jsonl vẫn cụt như cũ.
- **TC-04 (AC-06, AC-19, AC-20):** `POST/PUT/DELETE` → 405; `Host: evil.com` → 403; `GET /api/goals/..%2F..%2Fx/gate-log/1` và id sai định dạng → 400/404, không đọc ngoài controller home.
- **TC-05 (AC-22):** Sửa một dòng trong jsonl của Goal A → snapshot đánh dấu A bị lỗi toàn vẹn, Goal B bình thường.
- **TC-06 (AC-21):** Outcome chứa `<script>` → hiện thành chữ, không có thực thi (test hàm escape hoặc DOM).
- **TC-07 (AC-11):** Duyệt mọi giá trị `GoalStatus` (`transitions.ts:13`): mỗi status có đúng một holder; thêm status mới mà quên ánh xạ thì test hỏng.
- **TC-08 (AC-17, AC-18):** Không có lease → "không có tick đang chạy" và không có chữ "dừng"; có `controller.lease` với pid sống → "đang chạy một tick"; lease với pid chết → coi như không có.
- **TC-09 (AC-14):** Telemetry `usage: 'unknown'` → hiện `unknown`; có usage → hiện đúng token vào/cache/ra.
- **TC-10 (AC-02, AC-03):** Port bận → exit ≠ 0; kết nối từ địa chỉ không phải loopback bị từ chối.
- **TC-11 (AC-13):** Fixture Multi-WP ba package với phụ thuộc → đồ thị đúng nút, đúng mũi tên, đúng màu trạng thái.
- **TC-12 (AC-23, AC-24):** Làm `/api/snapshot` lỗi 500 → banner hiện kèm `readAt` cũ; tab ẩn thì không poll.
- **TC-13 (đo hiệu năng, không phải AC):** Chạy `controller tick` có và không có UI poll, so thời gian tick; UI không làm chậm đáng kể và không bao giờ chờ lock.

## 7. MÂU THUẪN NGUỒN / CẦN XÁC NHẬN / RỦI RO

**Mâu thuẫn nguồn** (design doc so với code):

| Nguồn A nói | Nguồn B thực tế (path) | Ảnh hưởng | Cần PM chọn |
|---|---|---|---|
| Design doc mục 6: dải trạng thái hiện "controller không giữ lease → controller dừng" | `controller.lease` chỉ có trong lúc một tick chạy, bị xoá ngay sau (`src/store/lease.ts:20-23`) | Nếu theo design doc, UI luôn báo "dừng" giữa hai tick: sai | Không cần chọn: spec dùng "tick đang chạy" + tuổi event cuối (AC-17, AC-18). Em sẽ sửa design doc cho khớp sau khi anh xác nhận |
| Design doc mục 5: telemetry lấy qua `MetricsService` | `MetricsService.show` không có token (`metrics.ts:3-12`); token nằm ở `state.telemetry` | Hiển thị chi phí sai nguồn | Không cần chọn: spec lấy từ `state.telemetry` |
| Design doc M3: inbox UI = inbox CLI | Inbox CLI không có cổng A, B (`cli-app.ts:396-402`) | UI "Cần anh" có thêm hai loại | Không cần chọn: UI dùng chung `buildInbox` và thêm hai loại ở read-model (AC-08, AC-09) |

**Câu hỏi (đều không chặn):**

| Qx | Câu hỏi | Đề xuất mặc định | Loại | REQ/task bị ảnh hưởng | Người quyết |
|---|---|---|---|---|---|
| Q-A | Tên lệnh và port mặc định | `apos ui`, port 4343 | Không chặn | BE-4, AC-01 | PM |
| Q-B | Tín hiệu "controller" trên dải trạng thái | Chỉ "tick đang chạy" (lease sống) + tuổi event cuối; không báo "dừng" | Không chặn | BE-3, FE-1, AC-17, AC-18 | PM |
| Q-C | `selected` và `planned` thuộc nhóm Lead; `ready` thuộc Controller | Như bảng AC-11 | Không chặn | BE-3, FE-1, AC-11 | PM |

**Rủi ro:**
- **Nghi ngờ:** đọc `jsonl` không lock khi controller đang `writeSync` giữa chừng có thể thấy dòng dở; AC-05 và TC-03 phủ trường hợp này. Chưa chứng minh được `fsync` ghi nguyên một dòng, nên dòng không kết thúc bằng `\n` luôn bị bỏ qua.
- **Đã xác minh:** agent cùng user OS gọi được `http://127.0.0.1:<port>` để đọc appetite; không ngăn được (PM đã chấp nhận ở Q6).
- Trạng thái `ready` có thể kéo dài nếu dispatch bị kẹt: UI chỉ hiện tuổi, không chẩn đoán.

## NGUỒN ĐÃ ĐỐI CHIẾU
- `src/store/event-log.ts:26,34-38,41-57` — constructor `mkdir`; `lines()` cắt dòng dở và kiểm hash; `append` ghi `fsync`.
- `src/store/journal.ts:10-20,36,54-80` — `GoalRepository`, `rebuildIndex` dưới `withLock`, `appendLocked`.
- `src/store/sqlite.ts:18-25` — `getGoal` gập `applyEvent`.
- `src/store/project-history.ts:39-47` — `withLock` chờ tới 15 giây.
- `src/store/lease.ts:13-27` — `controller.lease` chỉ trong lúc tick.
- `src/domain/transitions.ts:13-15,96-118,366-369` — `GoalStatus`, `PackageState`, `proposal-approved` → `ready`, `telemetry-recorded`.
- `src/app/metrics.ts:3-12`, `src/app/supervisor.ts:225` — metrics không có token; nơi ghi telemetry.
- `src/cli-app.ts:67-90,111,303,396-402` — `assertHuman`, `goal list`, `controller watch`, inbox.
- `docs/design/apos-ui.md` — thiết kế đã duyệt.
