# APOS UI: bảng xem chỉ đọc

`apos ui` mở một trang web local (`127.0.0.1`, `node:http`, một trang tĩnh, không dependency mới) cho Human xem dự án. Nó **không ghi gì**: không duyệt cổng, không đóng Goal, không chạy lệnh nào của CLI. Các quyết định của Human vẫn đi qua CLI (`goal approve`, `outcome close`, ...), mỗi lệnh có xác nhận tương tác.

## Hiện gì

- **Cần anh** (`inbox`): cổng A (duyệt Goal), cổng B (chọn Goal), Goal bị chặn (`blocked`), Goal đã verified chờ đóng, các thông báo, và **cảnh báo của gate** (`needs attention: ...`: đổi test, đường dùng chung, file build; chưa có khoá test tới đợt 3). Cùng một hàm `buildInbox` với `apos inbox`, nên hai nơi không lệch nhau.
- **Mỗi Goal:** trạng thái và ai giữ việc (Human, Lead, xong); gói và phụ thuộc (đồ thị, màu theo `pending/submitted/green/red/needs-human`); finding; kết quả gate kèm log (tra theo hash do APOS ghi); review (chỉ là lời khuyên); ngân sách (phút từ `goal select`, số lần đỏ nhiều nhất ở một gói); dòng thời gian sự kiện; "câu chuyện" Goal.
- **Goal `legacy`:** Goal do APOS v2 (có điều phối agent) ghi. Hiện nhãn "chỉ đọc – APOS cũ", đọc được, không chạy tiếp.
- Không có tab hay cột về agent, terminal, token hay tick của controller (đã bỏ ở đợt 1; thiết kế cũ ở `docs/archive/design/`).

## Bất biến

- UI đọc qua `ReadOnlyJournal`: không tạo thư mục, không cắt dòng cuối đang ghi dở, không lấy lock, không dựng lại sqlite. Hash toàn bộ controller home không đổi sau khi gọi mọi route (có test).
- Chỉ nghe `127.0.0.1`, từ chối Host lạ. Mọi text do agent viết được đặt bằng `textContent`, không bao giờ là markup.
- Log hash sai hay sự kiện không áp được chỉ làm hỏng Goal đó (báo `integrityError`), các Goal khác vẫn hiện.
