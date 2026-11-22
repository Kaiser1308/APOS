> **Lưu trữ (lịch sử).** Thiết kế xem hoạt động agent từ transcript; tab này đã bị bỏ ở v3 đợt 1. Không mô tả APOS v3 hiện hành; thiết kế v3: [`../../superpowers/specs/2026-11-22-apos-v3-design.md`](../../superpowers/specs/2026-11-22-apos-v3-design.md).

# APOS UI v2: "Câu chuyện" của một Goal (Lead hiểu gì, quyết gì; Worker làm gì)

Trạng thái: Đã duyệt (2026-11-12)

## 1. Vấn đề, mục tiêu đo được, không làm

**Vấn đề.** UI v1 (`docs/design/apos-ui.md`) cho thấy trạng thái, package, gate, telemetry. Nó không kể được **chuyện gì đang xảy ra**: Lead hiểu Goal thế nào, chọn tự làm hay chia nhiều Work Package và vì sao, Worker đang làm gì, kế hoạch và quyết định của nó là gì.

**Mục tiêu đo được.**
- M1. Mở một Goal đã được Lead nhận: thấy trên một màn hình (a) Goal anh giao, (b) Lead đề xuất gì: chế độ (solo hay chia), cách làm, lý do chia hoặc không chia, rủi ro, cách kiểm, chi phí ước tính so với appetite.
- M2. Mỗi owner (Solo owner hoặc từng Work Package) có một dòng thời gian: agent nói gì, lệnh nào chạy, file nào đổi, test ra sao, lỗi gì, cùng các báo cáo tới APOS (checkpoint, evidence, blocker, decision).
- M3. Khi Worker đang chạy, dòng thời gian tự cập nhật trong ≤ 3 giây sau khi agent ghi dòng mới vào transcript.
- M4. Mục "Quyết định" chỉ chứa thứ có nguồn: log APOS hoặc lời agent đã viết ra. Không suy diễn, không nhãn "AI nghĩ rằng".
- M5. Vẫn không ghi byte nào vào controller home, không đổi worktree, transcript.
- M6. Hỗ trợ transcript của Codex và Claude Code.

**Không làm.** Không hiện chain-of-thought thô (anh đã xác nhận "suy nghĩ" = quyết định và lý do agent nói ra). Không nút ghi, không gửi lệnh vào terminal (giữ read-only, Q7). Không bắt Lead ghi thêm trường "em hiểu yêu cầu là…" (đổi contract và skill, tách việc khác). Đọc màn hình terminal live của Orca để sang giai đoạn 2 (mục 5.7).

## 2. Hiện trạng

Đã đọc: `src/domain/contracts.ts`, `transitions.ts`, `src/cli-app.ts`, `src/runtime/orca.ts`, `telemetry.ts`, `supervisor.ts`, UI v1, và **transcript thật** trên máy anh (`~/.codex/sessions/2026/11/10/rollout-*.jsonl`, `~/.claude/projects/C--Users-thien/*.jsonl`). Chưa đọc: một phiên Worker do APOS dispatch (xem mục 8, U1).

| Hiện trạng (`path:dòng`) | Phải giữ | Muốn đổi | Chưa xác minh |
|---|---|---|---|
| Lead để lại proposal: `mode` (solo-direct/solo-phased/multi-wp), `approach`, `risks`, `splitRationale`, `sharedPaths`, `acceptanceMapping`, `verificationStrategy`, `estimatedCost` (`contracts.ts:96-118`). Multi-WP bắt buộc có `splitRationale` và `estimatedCost`. v1 chưa hiện các trường này (`read-model.ts:141-150`) | Contract | Hiện đầy đủ, kèm Goal gốc (`requirements`, `acceptance`, `scope`) | — |
| Package có `spec.outcome`, `owner`, `dependencies`, `attempts`, `blocker`, `findings`, gate riêng (`read-model.ts:169`) | | Gắn dòng thời gian Worker vào từng package | — |
| Log APOS chỉ có những gì agent **chọn báo**: `checkpointed {phase, progress, evidenceRefs}`, `decision-logged {note}`, `evidence-submitted`, `blocked`/`unblocked` (`cli-app.ts:190, 358-372`; `transitions.ts:264-279`). Thưa | Log bất biến | Hiện thành mục "Báo cáo tới APOS" và "Quyết định" | — |
| Việc Worker làm thật (lệnh, file, lời giải thích) **không có trong log APOS**; nằm trong transcript của agent. Code hiện chỉ đọc rollout Codex để lấy token: chọn thư mục ngày, khớp `session_meta.cwd` = worktree, cửa sổ thời gian ±30s (`telemetry.ts:14-60`) | Telemetry hiện tại | Dùng lại đường ghép này để đọc **nội dung** | — |
| Worktree của dispatch: `worktreePath(ref.worktreeId)` cắt phần sau `::` (`orca.ts:50`); supervisor dùng nó để đo token (`supervisor.ts:222-224`). Lead có `leadTerminal {terminal, worktree, runId}` trong state (`transitions.ts` `lead-woken`) | | Dùng làm khóa ghép dispatch → transcript | `worktreeId` có được lưu trong event để UI đọc lại, hay chỉ sống trong bộ nhớ/ref của controller |
| **Đã xác minh (transcript thật):** Codex rollout có `session_meta`, `turn_context`, `response_item/message` (lời agent), `custom_tool_call`+`_output` (tên `exec`, có `input`), `function_call`+`_output`, `event_msg/task_started|task_complete|token_count`. Claude Code jsonl có `assistant/text`, `assistant/tool_use`, `user/tool_result`, `system`, `attachment`, `ai-title` | | Chuẩn hóa hai định dạng thành một kiểu `Activity` | Tên công cụ lập kế hoạch (Claude `TodoWrite`? Codex `update_plan`?) chưa thấy trong mẫu |
| **Đã xác minh:** reasoning không đọc được. Codex: 258/258 mục `reasoning` có `summary` rỗng và `encrypted_content`. Claude: 6/6 khối `thinking` rỗng, chỉ có `signature` | — | Không hiện reasoning; "suy nghĩ" lấy từ lời agent viết và quyết định ghi vào APOS | Có thể khác ở bản agent/cấu hình khác |
| Mtime rollout trên Windows không cập nhật khi Codex còn mở file (ghi trong `telemetry.ts:26`) | | Chọn file theo thư mục ngày, không theo mtime | Claude Code có cùng vấn đề không |
| Rào human-only chặn lệnh ghi từ terminal agent (`cli-app.ts:67-90`) và UI v1 chỉ đọc | Giữ | Không đổi | — |
| Transcript nằm ngoài `~/.apos`, thuộc user OS; có thể chứa token, biến môi trường, đường dẫn | UI bind loopback, không đăng nhập (đã duyệt ở v1) | Đọc nội dung nhạy cảm hơn v1 | Mức che dữ liệu đủ chưa (Q5 theo đề xuất) |

## 3. Ràng buộc đã chốt

**Của anh:**
- "Suy nghĩ" = quyết định và lý do agent nói ra, không cần chain-of-thought (Q2).
- Worker dùng cả Codex và Claude Code (Q6).
- Theo đề xuất: Q1 đọc transcript agent làm nguồn chính; Q3 hiện Goal gốc cộng proposal hiện có; Q4 dòng thời gian gộp theo bước, poll 3 giây; Q5 che mẫu khóa/token, cắt mục dài; Q7 giữ read-only; Q8 cả Lead, Worker, Reviewer cùng một cơ chế.
- Q0: anh cho em chạy thử. Em đã dùng transcript thật có sẵn để xác minh định dạng; phiên APOS thật chưa chạy (mục 8, U1).

**Lựa chọn của em:**
- L1. Không dùng heuristic ngôn ngữ để "nhận ra quyết định" trong lời agent. Mục "Quyết định" chỉ lấy nguồn có cấu trúc (proposal, `decision-logged`, `blocked`, review, checkpoint). Lời agent nằm ở dòng thời gian, gắn nhãn "agent nói". Lý do: tránh UI khẳng định điều không có nguồn.
- L2. Đọc terminal live qua `orca terminal read` để sang giai đoạn 2: nó gọi tiến trình `orca`, phá tính "chỉ đọc file", và transcript đã gần live.
- L3. Không thêm dependency.

**Giả định:** transcript của một dispatch nằm trong thư mục sessions mặc định (`~/.codex/sessions`, `~/.claude/projects`), trên cùng máy với UI. Cho phép đổi bằng `CODEX_HOME` (đã có trong code) và `CLAUDE_CONFIG_DIR`.

## 4. Phương án và so sánh

Thước đo: độ đủ so với mong muốn của anh, độ đúng (không bịa), công xây, rủi ro bảo mật, ảnh hưởng tới APOS lõi.

| | A. Chỉ log APOS | B. Đọc transcript agent (đề xuất) | C. Bắt agent ghi nhật ký có cấu trúc vào log APOS |
|---|---|---|---|
| Độ đủ | Thấp: thưa, agent chỉ báo khi nhớ | Cao: thấy lệnh, file, lời giải thích, test | Cao nhưng chỉ khi agent tuân thủ |
| Độ đúng | Cao | Cao (nguyên văn), nhưng ghép sai phiên là rủi ro (mục 6) | Trung bình: agent tự khai |
| Công xây | Nhỏ | Vừa: hai bộ đọc, chuẩn hóa, che dữ liệu | Lớn: đổi contract, skill, brief, event mới |
| Bảo mật | Như v1 | Đọc dữ liệu nhạy cảm ngoài `~/.apos` | Như v1 |
| Ảnh hưởng lõi | Không | Không (chỉ đọc) | Có: đổi `transitions.ts`, `apos-*` skills |
| Đổi lại được | — | Xóa module là xong | Khó: event đã vào log bất biến |

**Chọn B**, giữ A làm nguồn "đã báo cáo" bên cạnh. C bị loại vì làm đổi lõi và event log không thể rút lại; chỉ cân nhắc nếu sau này anh muốn trường "Lead hiểu gì" bắt buộc (Q3).

## 5. Quyết định: luồng, dữ liệu, interface, bất biến

### 5.1 Màn hình Goal: tab mặc định "Câu chuyện"

Các tab cũ (Tổng quan, Cổng, Dòng sự kiện) giữ nguyên. Thêm "Câu chuyện" lên đầu, từ trên xuống:

1. **Anh giao.** Outcome, requirement, acceptance, scope, loại trừ, appetite.
2. **Lead hiểu và quyết định.** Chế độ nói bằng lời thường ("Tự làm một mạch", "Tự làm theo giai đoạn", "Chia N package"). Cách làm (`approach`). Vì sao chia hoặc không chia (`splitRationale`; nếu solo thì ghi "không có lý do chia" vì chỉ Multi-WP bắt buộc). Rủi ro, đường dùng chung (`sharedPaths`), cách kiểm (`verificationStrategy`), bảng acceptance → cách kiểm. Chi phí ước tính so với appetite. Với Multi-WP: danh sách package và sơ đồ phụ thuộc (đã có ở v1). Dưới cùng: "Lead đã nói" (lời Lead trong transcript, nhãn "agent nói").
3. **Mỗi owner** (Solo hoặc mỗi package) một khối:
   - Đầu khối: trạng thái, số lần thử/tối đa, phút đã chạy, token, agent và model đã chạy thật.
   - **Quyết định:** `decision-logged`, `blocked`/`unblocked` kèm lý do, finding, review của owner đó, theo thời gian.
   - **Kế hoạch:** bản kế hoạch hoặc todo mới nhất agent đưa ra (nếu có công cụ lập kế hoạch trong transcript; không có thì ẩn mục).
   - **Việc đã làm:** dòng thời gian bước: agent nói, lệnh, file đổi, kết quả test, lỗi. Mặc định mới nhất ở trên, bấm một mục để xem nguyên văn đã cắt.
   - **Báo cáo tới APOS:** checkpoint, evidence.
4. **Reviewer** và **Gate**: dùng cơ chế owner cho từng dispatch reviewer; gate dùng phần v1.

### 5.2 Dữ liệu: kiểu `Activity` chuẩn hóa

```
Activity = { id, at, role: 'lead'|'worker'|'reviewer', source: 'codex'|'claude',
  kind: 'say'|'plan'|'command'|'file-change'|'result'|'error'|'meta',
  text: string /* đã che, ≤ 4 KB */, truncated: boolean, detail?: string }
```
- Codex: `message` (assistant) → `say`; `custom_tool_call`/`function_call` → `command` (hoặc `file-change` nếu là patch); `*_output` → `result`/`error` theo mã thoát nếu có; `update_plan` (nếu có) → `plan`.
- Claude Code: `assistant/text` → `say`; `tool_use` (Bash → `command`, Edit/Write → `file-change`, TodoWrite → `plan`); `tool_result` → `result`/`error` (`is_error`).
- Bản ghi không nhận ra → đếm vào `meta` ("N bản ghi không hiển thị"), **không** làm hỏng trang.
- Reasoning/thinking: bỏ qua hoàn toàn.

### 5.3 Ghép dispatch → transcript

1. Từ event log lấy từng dispatch: `dispatchId`, owner (`package-started`, `execution-started`, `review-dispatched`, Lead), thời điểm bắt đầu, thời điểm settle (từ `worker-settled`/telemetry), và worktree (`worktreeId` → `worktreePath`).
2. Codex: giữ logic đã có (thư mục ngày quanh cửa sổ, khớp `session_meta.cwd`). Claude Code: thư mục `~/.claude/projects/<cwd mã hóa>/` rồi **kiểm lại `cwd` trong chính bản ghi** (không tin tên thư mục).
3. Lọc bản ghi theo `timestamp` trong cửa sổ `[start − 30s, settle + 30s]` (đang chạy thì tới "bây giờ"). Một worktree dùng lại qua nhiều dispatch sẽ không lẫn.
4. Không tìm thấy: khối hiện "Không có transcript cho dispatch này" cùng phần log APOS. Không báo lỗi trang.

### 5.4 Interface (chỉ GET, như v1)

- `GET /api/goals/:id/story`: Goal gốc, proposal đã dựng, owner list (kèm quyết định, báo cáo, dispatch). Không có nội dung transcript.
- `GET /api/goals/:id/activity/:dispatchId?after=<offset>&limit=<n≤200>`: trả `{items, nextOffset, truncated, transcriptFound}`. `dispatchId` phải khớp một dispatch **đã ghi trong log của Goal đó** (regex id như v1); đường dẫn transcript do server tự dẫn ra, không nhận từ request.
- Poll 3 giây gọi lại với `after=nextOffset`, chỉ đọc phần mới của file. Tab ẩn thì dừng (như v1).
- Giới hạn: mỗi mục ≤ 4 KB, mỗi phản hồi ≤ 200 mục, một lần quét file ≤ 8 MB (file lớn hơn thì đọc từ offset).

### 5.5 Che dữ liệu (Q5)

Trước khi trả ra, thay các mẫu: `sk-…`, `ghp_…`/`github_pat_…`, `AKIA…`, `Bearer …`, `-----BEGIN … PRIVATE KEY-----…`, và giá trị của biến có tên chứa `KEY|TOKEN|SECRET|PASSWORD` trong dòng `NAME=value`. Đường dẫn giữ nguyên. Đây là che ở mức "khớp mẫu", **không bảo đảm** che hết; README phải ghi rõ.

### 5.6 Bất biến

- I1. Không ghi: không tạo, sửa, khóa, xóa file trong controller home, worktree, thư mục transcript.
- I2. Mọi chuỗi động vào trang bằng `textContent` (giữ quy tắc v1); chuỗi che/cắt xảy ra phía server.
- I3. `dispatchId` và `after` là đầu vào đã kiểm; không có đường nào từ request thành đường dẫn file.
- I4. Mục "Quyết định" chỉ từ nguồn có cấu trúc (L1).
- I5. Số liệu cũ của v1 (inbox, trạng thái, telemetry) không đổi.

### 5.7 Giai đoạn 2 (chưa duyệt, ghi để khỏi quên)

Đọc terminal Orca live qua `orca terminal read` cho khoảng trống khi transcript chưa flush; cần xác minh nó có phá tính chỉ đọc không.

## 6. Failure modes và quan sát

Đây là công cụ local, không có cảnh báo gửi ra ngoài; "quan sát" là **dấu hiệu hiện trên trang** và người xử lý là anh.

| Lỗi | Bất biến | Phát hiện | Xử lý |
|---|---|---|---|
| Ghép nhầm transcript (hai phiên cùng worktree, lệch giờ) | I4 và độ đúng | Cửa sổ thời gian hẹp; hiện nhãn "ghép theo worktree + giờ" và số phiên khớp; >1 phiên khớp thì hiện cả hai kèm giờ | Anh nhìn nhãn; không tự chọn thay anh |
| Transcript bị xóa hoặc ở máy khác | Trang không hỏng | `transcriptFound:false` | Hiện phần log APOS; ghi rõ lý do |
| File rất lớn, dòng cuối ghi dở | Không treo, không sai | Quét giới hạn 8 MB, bỏ dòng cuối không có `\n` (như v1) | Đọc tiếp lần poll sau |
| Định dạng agent đổi | Không vỡ trang | Bản ghi lạ đếm vào `meta` | Cập nhật bộ đọc; có test mẫu |
| Lộ bí mật trong transcript | Không phát tán ra ngoài máy | Loopback + Host check như v1; che mẫu | Anh quyết (Q5). Không bảo đảm che hết |
| Mã độc trong transcript (prompt injection, HTML) | I2 | Test: chuỗi `<script>`, `<img onerror>` hiển thị thành chữ | — |
| Agent chạy nhiều giờ, transcript phình | UI không chậm | Poll theo offset; giới hạn 200 mục | — |
| UI đọc khi agent đang ghi | I1 | Đọc không khóa; chỉ nhận dòng đủ `\n` | — |

## 7. Chuyển đổi

- Không migration, không backfill, không đổi event, không đổi contract, không đổi skill. Thêm tab và hai route; UI v1 vẫn hoạt động nếu bộ đọc transcript lỗi.
- Thứ tự rollout: (1) tab "Câu chuyện" phần Goal + Lead + báo cáo APOS (không cần transcript, giá trị ngay); (2) bộ đọc Codex; (3) bộ đọc Claude Code; (4) che dữ liệu và README.
- Rollback: gỡ tab và route. Không có trạng thái cần dọn.
- Phần không rollback được: không có.

## 8. Điều chưa chắc

| ID | Nội dung | Cách xác minh | Ai quyết | Chặn? |
|---|---|---|---|---|
| U1 | `worktreeId` có nằm trong event: **Đã xác minh** (`RuntimeRef.worktreeId` là dữ liệu của `execution-started`, `package-started`/`package-resumed` qua `ref`, và `review-dispatched`, `orca.ts:10-13`). Bộ đọc đã chạy trên transcript Codex và Claude Code thật của máy này (672 và 17 mục). Chưa xác minh: một phiên Worker do controller APOS dispatch trên Orca có ghép đúng bằng worktree + giờ không | Chạy một Goal thật nhỏ qua `controller watch` | Anh | Không chặn |
| U2 | Tên thư mục dự án của Claude Code: **Đã xác minh** `cwd` thay mọi ký tự không phải chữ số với `-`; bộ đọc vẫn kiểm `cwd` trong bản ghi | — | Em | Không |
| U3 | Công cụ kế hoạch: Claude là `TodoWrite` (đã thấy trong code, test bằng mẫu giả lập); Codex: tên chứa `plan` được nhận là kế hoạch, chưa thấy trong mẫu thật | Quét mẫu Codex có `update_plan` | Em | Không |
| U4 | Mức che dữ liệu | Anh xem mẫu sau khi làm | Anh | Không |

## 9. Bàn giao

**Nguồn cho `spec-to-dev-tasks`:** file này; `docs/design/apos-ui.md`; `src/ui/read-model.ts`, `src/ui/page.ts`, `src/ui/server.ts`; `src/runtime/telemetry.ts`; `src/domain/contracts.ts`.

**Việc cần kiểm chứng:**
- Test I1: băm cây `~/.apos` và thư mục transcript trước/sau 100 lần gọi mọi route, phải bằng nhau.
- Test ghép: hai phiên cùng worktree khác giờ → mỗi dispatch chỉ thấy phần của mình; không có phiên → `transcriptFound:false`.
- Test định dạng: mẫu Codex và Claude thật (đã che) trong fixtures; bản ghi lạ không làm hỏng; dòng cuối đứt bị bỏ.
- Test I2/I3: `<script>` trong lời agent hiện thành chữ; `dispatchId` lạ hoặc kiểu `../` bị từ chối.
- Test che: chuỗi `sk-…`, `ghp_…`, `API_KEY=…` không còn trong phản hồi.
- Chạy thật U1 trước khi gọi xong bước 2 và 3.
