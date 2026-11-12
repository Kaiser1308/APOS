# APOS UI: bảng điều khiển web local cho Human

Trạng thái: Đã duyệt (2026-11-12)

## 1. Vấn đề, mục tiêu đo được, không làm

**Vấn đề.** Human (anh) chỉ nhìn APOS qua CLI: `apos goal list` và `apos inbox` in text phân tách bằng tab (`src/cli-app.ts:111`, `:396`). Muốn biết "Goal nào đang cần mình, nó kẹt ở đâu, tốn bao nhiêu" phải chạy nhiều lệnh rồi tự ghép.

**Mục tiêu đo được (v1, chỉ xem).**
- M1. Mở `apos ui` thấy ngay mọi việc cần anh làm (cổng A, B, D, `needs-decision`, notice) trên một màn hình, không cuộn, không bấm sâu.
- M2. Mỗi Goal xem được: trạng thái, ai đang giữ việc, package và phụ thuộc (Multi-WP), finding, kết quả gate kèm log, review, telemetry/chi phí so với appetite, timeline event.
- M3. Số liệu trên UI luôn khớp CLI: cùng một hàm tính "inbox", không có hai phiên bản logic.
- M4. UI không thay đổi bất kỳ byte nào trong controller home (`events/*.jsonl`, `state.sqlite`, `sources/`, `artifacts/`).
- M5. Không thêm dependency runtime (giữ `commander`, `zod`).

**Không làm (v1).** Không có nút ghi: không duyệt cổng, không `outcome close`, không `gate confirm`. Không chạy hay điều khiển `controller watch`. Không đa người dùng, không đăng nhập, không truy cập từ máy khác. Không chọn nhiều project.

## 2. Hiện trạng

| Hiện trạng (`path:dòng`) | Phải giữ | Muốn đổi | Chưa xác minh |
|---|---|---|---|
| Không có HTTP server hay API đọc trong `src/`. Mọi tương tác qua CLI `apos` (`src/cli-app.ts:47-410`) | CLI là đường ghi duy nhất | Thêm lệnh `apos ui` chỉ đọc | Chạy nền UI cùng `controller watch` có ổn trên Orca/Windows |
| Nguồn sự thật là `events/<GOAL>.jsonl`, hash chain (`src/store/event-log.ts:25`). `state.sqlite` chỉ có bảng `events` (`src/store/sqlite.ts:9`). Trạng thái do `ProjectJournal` tính (`listGoals`, `getGoal`, `events`; `src/store/journal.ts:28-52`) | Event log là nguồn duy nhất | UI đọc qua `ProjectJournal`, không tự parse jsonl hay SQL | Xem mục 8 (U1, U2) |
| Mở journal có tác dụng phụ: `EventLog` tạo thư mục (`event-log.ts:26`), `rebuildIndex` ghi sqlite dưới lock (`journal.ts:36`), và đọc log cắt dòng cuối bị đứt (`truncateSync`, `event-log.ts:44`) | Phục hồi sau crash của controller | Đường đọc của UI không được ghi | Việc cắt dòng đứt có an toàn khi controller đang ghi dở (chỉ an toàn nếu có lock) |
| Đầu ra CLI là text tab, không phải JSON (`goal list` `:111`, `inbox` `:396`). Logic inbox nằm inline trong action của CLI | Định dạng CLI hiện tại (có test `src/cli.test.ts`) | Rút logic inbox thành hàm dùng chung cho CLI và UI | |
| Trạng thái Goal: `draft, approved, selected, planned, ready, executing, blocked, verified, closed, stopped`. Package: `specified, dispatching, resuming, executing, blocked, verified, stale` (`src/domain/transitions.ts:13-15`) | | UI nhóm theo "ai đang giữ việc" (mục 5) | Trạng thái `ready` nghĩa là controller sắp dispatch, hay còn chờ Human |
| Lệnh Human-only bị chặn từ terminal/worktree APOS đã dispatch (`cli-app.ts:67-90`) | Rào này giữ nguyên | v1 không có nút ghi nên không đụng | v2 sẽ phải xử lý |
| `controller watch` bắt buộc trong terminal Orca (`cli-app.ts:303`) | | UI chạy ngoài Orca, chỉ quan sát | Có biết controller đang sống không: có `withControllerLease` (`src/store/lease.ts:13`), chưa đọc xem lộ ra đủ thông tin |
| Appetite chỉ controller giữ, không vào tài liệu hay brief (README) | Không đưa vào brief, worktree agent | Hiển thị cho Human trên UI | Agent cùng user OS vẫn đọc được `~/.apos` (README: trust boundary chỉ là tamper-evident) |
| Có `MetricsService.show(goalId)` (`src/app/metrics.ts:14`) cho telemetry | Dùng lại | | Hình dạng đủ cho hiển thị chi phí |
| Controller home theo repo: `~/.apos/projects/<repo>-<hash>` (`event-log.ts:11`) | | v1 một repo qua `--repo` | |

**Nguồn đã đọc:** `src/cli-app.ts`, `src/store/*`, `src/domain/transitions.ts`, `src/app/metrics.ts`, `README.md`, đầu `docs/FINAL-DESIGN.md`. **Chưa có:** mockup hay tài liệu luồng Human (anh đã đồng ý Q0: em tự dựng theo cổng A/B/D + inbox); các lần chạy Hard12 không nằm trong repo.

## 3. Ràng buộc đã chốt

Của anh (đồng ý với đề xuất của em):
- Q1 v1 chỉ xem. Q2 web local `apos ui`, `node:http` + một trang tĩnh, không dependency mới. Q3 chỉ localhost, không đăng nhập. Q4 một repo theo `--repo`. Q5 tự poll mỗi 3 giây, chỉ đọc. Q6 hiển thị cả appetite và token telemetry. Q7 UI chỉ quan sát, controller vẫn chạy riêng.
- Anh cho em tự tìm hiểu mô hình bố trí: kết quả ở mục 4, và đây là lựa chọn của em cần anh duyệt.

Giả định (không đổi quyết định): ít Goal cùng lúc (vài chục trở xuống); timeline giới hạn 200 event gần nhất mỗi Goal; giờ hiển thị theo múi giờ máy của anh.

## 4. Phương án bố trí và so sánh

Thước đo chung: (a) trả lời được "việc gì cần mình" trong 5 giây; (b) khớp mô hình APOS (ít cổng Human, controller tự chuyển trạng thái, Multi-WP có phụ thuộc); (c) công xây và bảo trì; (d) mở rộng sang nút ghi ở v2.

| Mô hình | (a) Cần mình | (b) Khớp APOS | (c) Công | (d) v2 |
|---|---|---|---|---|
| **A. Kanban theo status** (10 cột) | Kém: việc cần Human rải ở 4 cột (`draft`, `approved`, `blocked`, `verified`) | Kém: thẻ do controller tự chuyển, kéo-thả vô nghĩa; không có WIP limit; 10 cột quá rộng cho vài Goal | Thấp | Không hợp, kéo thẻ không phải hành động của APOS |
| **B. Inbox-first** (hàng đợi "cần anh") + bảng Goal | Tốt nhất | Tốt: đúng với vai trò Human chỉ quyết ở cổng A/B/D | Thấp | Tốt: mỗi dòng inbox là chỗ đặt nút duyệt |
| **C. Pipeline/stepper theo Goal** (A → B → plan → thực thi → gate → review → D) + đồ thị package | Trung bình (phải mở từng Goal) | Tốt nhất cho một Goal: thấy chặng nào đã qua, package nào chặn ai | Trung bình (đồ thị DAG) | Tốt |
| **D. Timeline/log phẳng** | Kém | Là dữ liệu gốc nhưng khó đọc | Thấp | Kém |

**Chọn: B + C, thêm D ở dạng tab phụ.** Kanban bị loại vì mô hình thẻ-do-người-kéo không đúng với APOS. Cụ thể:

1. **Màn chính, cột trái: "Cần anh"** (Inbox). Mỗi dòng: Goal, lý do (chờ cổng A, chọn Goal cổng B, `needs-decision` + lý do, `verified` chờ cổng D, notice Multi-WP), tuổi chờ.
2. **Màn chính, giữa: bảng Goal nhóm theo "ai đang giữ việc"**, không nhóm theo 10 status thô:
   - *Anh*: `draft`, `approved`, `blocked`, `verified`.
   - *Lead*: `selected`, `planned`.
   - *Controller / agent*: `ready`, `executing`.
   - *Xong*: `closed`, `stopped` (thu gọn mặc định).
   Cột: id, outcome, mode (Solo/Multi-WP), tiến độ package `x/y`, chi phí so với appetite, tuổi từ event cuối.
3. **Chi tiết Goal (bấm vào):** stepper vòng đời; đồ thị package (nút = package, màu = trạng thái, mũi tên = phụ thuộc) khi Multi-WP; finding; kết quả gate từng lần (check, commit, log); review; telemetry theo dispatch; appetite và mức đã dùng; tab Timeline (D).
4. **Dải trạng thái trên cùng:** thời điểm đọc gần nhất, event cuối bao lâu trước, controller có đang giữ lease không.

## 5. Quyết định: luồng, dữ liệu, interface, bất biến

**Thành phần (thêm mới, không đổi hành vi CLI):**
- `src/ui/read-model.ts`: hàm thuần `buildSnapshot(reader)` trả một JSON: `{ readAt, lastEventAt, tickRunning, inbox[], goals[] }`. Mỗi goal gồm trạng thái, nhóm "ai giữ", package, finding, gate, review, telemetry (từ `state.telemetry`; `MetricsService` không có token), appetite. Hợp đồng chi tiết ở `apos-ui-tasks.md` mục 4.
- Rút logic inbox từ `cli-app.ts:396-402` thành `buildInbox(reader)` trong `src/app/`, CLI và UI cùng gọi (M3). CLI giữ nguyên định dạng in. UI thêm hai loại chỉ có ở UI: chờ cổng A (`draft`) và chờ cổng B (`approved`), vì inbox CLI không có hai loại này.
- `src/ui/server.ts`: `node:http`, route GET: `/` (trang tĩnh), `/api/snapshot`, `/api/goals/:id` (kèm timeline, `?limit=200`), `/api/goals/:id/gate-log/:logId`, `/api/goals/:id/source/:version`. Mọi phương thức khác trả 405.
- `src/ui/static/index.html`: một file, JS thuần, poll `/api/snapshot` mỗi 3 giây.
- `apos ui [--port <n>]` đăng ký trong `cli-app.ts`; mặc định port cố định, bind `127.0.0.1`; in URL.
- **Đường đọc không ghi:** thêm chế độ đọc cho `EventLog`/`ProjectJournal` (`readonly`): không `mkdir`, không `truncateSync`, không `rebuildIndex`, bỏ dòng cuối chưa hoàn chỉnh khi đọc thay vì cắt. UI không dùng `state.sqlite`, tự tính trạng thái từ event qua cùng hàm projection mà `getGoal` dùng, để không phụ thuộc index.

**Bất biến:**
- I1. UI không ghi vào controller home và không gọi lệnh ghi nào của CLI.
- I2. Server chỉ nghe `127.0.0.1`; từ chối request có `Host` khác `127.0.0.1:<port>` / `localhost:<port>` (chống DNS rebinding).
- I3. Đường dẫn log/source chỉ nhận id/version đã kiểm (`GOAL-[A-Z0-9-]+`, số nguyên), ánh xạ tới file qua danh sách đã biết; không nhận đường dẫn thô (chống path traversal).
- I4. Dữ liệu hiển thị luôn kèm `readAt`; lỗi đọc hiện banner đỏ, không hiện dữ liệu cũ như thể mới.
- I5. Chuỗi hash event bị đứt hiện cảnh báo toàn trang cho Goal đó (`EventLog` đã báo tampering).
- I6. Nội dung lấy từ event/log/source được escape khi render (không `innerHTML` với dữ liệu ngoài): outcome, note, log có thể chứa ký tự do agent ghi.

## 6. Failure modes và quan sát

| Lỗi | Bất biến / xử lý | Phát hiện | Ai xử lý |
|---|---|---|---|
| Controller đang ghi, UI đọc dòng cuối dở | Bỏ dòng cuối chưa hoàn chỉnh, không cắt file (I1) | Test mục 8 | Tự phục hồi lần poll sau |
| Hash chain đứt | Banner cảnh báo cho Goal đó (I5), phần còn lại vẫn hiển thị | UI hiện, stderr ghi | Anh điều tra (README: tamper-evident) |
| Controller có thể đã dừng | Dải trạng thái hiện tuổi event cuối và "đang chạy một tick" khi lease sống. **Không** kết luận "dừng" từ việc thiếu lease: lease chỉ có trong lúc một tick chạy (`lease.ts:20-23`) | Tuổi event cuối, lease | Anh chạy lại `controller watch` nếu event cuối quá cũ |
| Port đã dùng | `apos ui` thoát với thông báo rõ | exit code ≠ 0 | Anh chọn `--port` |
| Log lớn, timeline nặng | Giới hạn 200 event, phân trang | Test | |
| Agent cùng user OS gọi `http://127.0.0.1:<port>` đọc appetite | **Không ngăn được**: agent cùng user vốn đọc được `~/.apos` (README trust boundary). Ghi nhận là rủi ro dư, không giảm bớt | | Anh biết và chấp nhận (Q6) |
| Trình duyệt mở nhiều tab | Mỗi tab poll riêng, tải nhỏ (một snapshot / 3 giây) | | |

**Quan sát và cảnh báo:** đây là công cụ local một người dùng nên **không có cảnh báo chủ động** (mục không áp dụng); lỗi ghi ra stderr của `apos ui` và hiện trên banner. Người xử lý: anh.

**Phép kiểm chứng (vitest, dùng `fixtures.test-support.ts`):**
- T1. Snapshot khớp inbox CLI: cùng bộ event → `buildInbox` cho cùng kết quả mà CLI `inbox` in (M3).
- T2. Bất biến I1: chụp hash toàn bộ controller home (jsonl, sqlite, sources, artifacts) trước và sau 100 request tới mọi route; phải bằng nhau, kể cả khi jsonl có dòng cuối cụt.
- T3. Request `POST`/`PUT`/`DELETE` → 405; `Host: evil.com` → 403; `GET /api/goals/..%2F..%2Fx/gate-log/1` và id sai định dạng → 404 hoặc 400, không đọc file ngoài.
- T4. Event log có một dòng bị sửa → snapshot đánh dấu Goal đó, các Goal khác vẫn trả về.
- T5. Controller giữ lock/ghi liên tục trong lúc UI poll: UI không treo quá một khoảng timeout, không làm chậm `controller tick` (đo thời gian tick có/không UI).
- T6. Dữ liệu có `<script>` trong outcome/note không thực thi khi render (kiểm bằng test DOM hoặc kiểm hàm escape).
- T7. Nhóm "ai giữ" phủ đủ 10 status: test bảng ánh xạ không thiếu status nào (thêm status mới mà quên ánh xạ thì test hỏng).

## 7. Chuyển đổi

- Thêm mới hoàn toàn: không đổi schema, không migration, không backfill. Chỉ đụng code hiện có ở hai chỗ: rút `buildInbox` (CLI phải in y như cũ, `cli.test.ts` giữ nguyên) và thêm chế độ đọc cho `EventLog`/`ProjectJournal` (đường ghi không đổi).
- Thứ tự: (1) rút `buildInbox` + test; (2) chế độ đọc không ghi + T2; (3) read-model + T1, T4, T7; (4) server + T3, T5; (5) trang tĩnh + T6.
- Rollback: xoá `src/ui/`, bỏ subcommand `ui`; hàm `buildInbox` và chế độ đọc vô hại, có thể để lại. Không có dữ liệu không rollback được.
- v2 (ngoài phạm vi): nút ghi cho cổng A, B, D phải thiết kế riêng (CSRF token, xác nhận hai bước, tương tác với `assertHuman`).

## 8. Điều chưa chắc

| ID | Điều chưa chắc | Cách xác minh | Ai quyết | Chặn? |
|---|---|---|---|---|
| U1 | ~~Đọc không lock có bắt được dòng cuối đang ghi dở~~ **Đã xác minh (2026-11-12):** `EventLog.lines()` cắt dòng dở ngay khi đọc (`event-log.ts:34-38`), nên UI dùng `ReadOnlyJournal` riêng, bỏ dòng cuối không có `
`, không lock. Còn cần chạy T5/TC-03 | Test | Em | Không chặn nữa |
| U2 | ~~Projection có tách khỏi `ProjectJournal` được không~~ **Đã xác minh:** `applyEvent` thuần, gập từ `undefined` (`sqlite.ts:18-20`) | | Em | Không chặn nữa |
| U3 | ~~`ready` thuộc ai~~ **Đã xác minh:** controller chấp nhận plan của Lead rồi mới `ready` (`transitions.ts:~118`), nên `ready` thuộc nhóm Controller | | | Không chặn |
| U4 | ~~Lease có cho biết controller sống không~~ **Đã xác minh: không**, chỉ cho biết một tick đang chạy | | | Không chặn |
| U5 | Tên route `apos ui` và port mặc định | | Anh | Không chặn |
| U6 | Windows: bind và mở trình duyệt tự động | Chạy thử | Em | Không chặn |

## 9. Bàn giao

Nguồn cho `spec-to-dev-tasks`: file này, cộng `src/cli-app.ts:396-402` (inbox), `src/store/event-log.ts`, `src/store/journal.ts`, `src/domain/transitions.ts:13-15`, `src/app/metrics.ts`.

Việc chia task: `docs/design/apos-ui-tasks.md`. U1–U4 đã xác minh; U5, U6 còn mở, không chặn. Phép kiểm bắt buộc: T1 đến T7 (đã mở rộng thành TC-01 đến TC-13 trong file task).
