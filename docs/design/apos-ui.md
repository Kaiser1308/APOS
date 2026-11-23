# APOS UI: bảng xem chỉ đọc

`apos ui` mở một trang web local (`127.0.0.1`, `node:http`, một trang tĩnh, không dependency mới) cho Human xem dự án. Nó **không ghi gì**: không duyệt cổng, không đóng Goal, không chạy lệnh nào của CLI. Các quyết định của Human vẫn đi qua CLI (`goal approve`, `outcome close`, ...), mỗi lệnh có xác nhận tương tác.

## Hiện gì

- **Cần anh** (`inbox`): cổng A (duyệt Goal), cổng B (chọn Goal), Goal bị chặn (`blocked`), Goal đã verified chờ đóng, các thông báo, và **cảnh báo của gate** (`needs attention: ...`: đổi test, đường dùng chung, file build, đổi hạ tầng test). Cùng một hàm `buildInbox` với `apos inbox`, nên hai nơi không lệch nhau.
- **Mỗi Goal** có bốn tab: `story`, `overview`, `gates`, `timeline`.
  - `overview`: các bước trạng thái và ai giữ việc (Human, Lead, xong); ngân sách (số lần đỏ nhiều nhất ở một gói, phút từ `goal select`) kèm **setup đã ghim** (`setup v<n>`, hoặc `không có setup`); gói và phụ thuộc (đồ thị, màu theo `pending/submitted/green/red/needs-human`); **bảng mức bảo đảm**; finding; review (chỉ là lời khuyên, kết quả `pass`/`fail` của lệnh `review`).
  - `gates`: mỗi cổng gói, cổng của Goal và cổng sau merge, từng kiểm với lý do và log (tra theo hash do APOS ghi). Các kiểm của bằng chứng hiện ở đây: `APOS-LOCKED` (test đã khoá), `APOS-REVIEW` (test của review chặn), `APOS-INVENTORY`, phạm vi, test hạ tầng, và từng lớp `<part>.<layer>.<tool>`.
  - `timeline`: mọi sự kiện, kể cả khoá test, ngoại lệ và `review-blocked`, mới nhất trước.
  - `story`: câu chuyện của Goal (quyết định, báo cáo, chặn, finding, review).
- **Bảng mức bảo đảm** là cùng văn bản với `apos goal show`, dựng từ log bằng `buildAssuranceReport`: số tiêu chí máy chứng minh và số anh xác nhận tay; **test đã khoá** theo lớp và số lần sửa sau khoá; kiểm kê và phạm vi; lớp đã chạy ở từng khâu (submit, ghép, đóng) kèm dấu đạt, đỏ hay chưa kiểm; **review chặn** (số lần chặn bằng test đỏ, số test đã khoá vào lần giao sau, review bị bỏ qua và ai duyệt); **ngoại lệ** đã duyệt; **agent duyệt thay**; những gì tắt hoặc chưa kiểm. Số đo hiện bằng nhãn ngắn (`p99 0.39`, `mutationScore 82`), đường dẫn đầy đủ nằm trong report. UI không nạp setup, nên bảng chỉ có những gì log nói: lớp chưa chạy vì setup thiếu công cụ hiện khi cổng ghi lại điều đó.
- **Goal `legacy`:** Goal do APOS v2 (có điều phối agent) ghi. Hiện nhãn "chỉ đọc – APOS cũ", đọc được, không chạy tiếp.
- Không có tab hay cột về agent, terminal, token hay tick của controller (thiết kế cũ ở `docs/archive/design/`).

## Bất biến

- UI đọc qua `ReadOnlyJournal`: không tạo thư mục, không cắt dòng cuối đang ghi dở, không lấy lock, không dựng lại sqlite. Hash toàn bộ controller home không đổi sau khi gọi mọi route (có test).
- Chỉ nghe `127.0.0.1`, từ chối Host lạ. Mọi text do agent viết được đặt bằng `textContent`, không bao giờ là markup.
- Log hash sai hay sự kiện không áp được chỉ làm hỏng Goal đó (báo `integrityError`), các Goal khác vẫn hiện.
