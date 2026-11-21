# G3: APOS dùng tín hiệu Orca thay cho đọc màn hình

APOS không được đọc màn hình terminal của agent hay tự gõ vào ô nhập của agent nữa. Thay vào đó dùng tín hiệu chính thức của Orca để biết agent đang thế nào.

1. Bỏ việc tự nhấn Enter vào terminal của agent. Khi lượt làm việc của agent chưa bắt đầu (brief chưa được nhận), APOS báo anh thay vì tự gõ.
2. Biết agent hết quota qua escalation Orca gửi, không qua dò màn hình.
3. Biết agent dừng mà không báo xong qua escalation có lý do dừng của Orca, không phải chờ 15 phút idle mới biết. Lưới an toàn idle 15 phút vẫn giữ.
4. Khi agent đang chờ một câu hỏi mà chỉ người trả lời được, APOS báo anh.
5. Phần duy nhất còn dò là brief Codex bị dán mà chưa gửi: dò bằng trường draft hoặc worker.stage của Orca, không dùng regex màn hình.
6. Hành vi khác của APOS giữ nguyên.
7. Test do owner viết cho các điểm trên phải được kiểm là thật sự thử đúng tín hiệu Orca, không chỉ cho xanh.
