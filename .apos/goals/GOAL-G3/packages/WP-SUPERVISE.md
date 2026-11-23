# WP-SUPERVISE v2: Giám sát của APOS dùng agent-signals@v1 thay cho đọc màn hình: không còn gõ vào agent, các trạng thái cần anh biết đều thành notice, lưới idle 15 phút vẫn giữ.

```json
{
  "id": "WP-SUPERVISE",
  "goalId": "GOAL-G3",
  "goalVersion": 2,
  "version": 2,
  "owner": "worker",
  "outcome": "Giám sát của APOS dùng agent-signals@v1 thay cho đọc màn hình: không còn gõ vào agent, các trạng thái cần anh biết đều thành notice, lưới idle 15 phút vẫn giữ.",
  "scope": [
    "src/app/supervision.ts",
    "src/app/watch.ts",
    "src/runtime/screens.ts",
    "src/runtime/orca/adapter.ts (chỉ phần gọi terminal send/read)",
    "src/runtime/README.md",
    "test tương ứng"
  ],
  "exclusions": [
    "không đổi domain/transitions, gate-service, luật cổng Human",
    "không thêm dependency",
    "không làm G4, G5, G6",
    "không sửa src/ports/runtime.ts (WP-SIGNALS đã làm); nếu cần thì hỏi Lead"
  ],
  "dependencies": [
    "WP-SIGNALS"
  ],
  "interfaces": [
    "agent-signals@v1 (nhận từ WP-SIGNALS)"
  ],
  "acceptance": [
    {
      "id": "SUP-1",
      "text": "Trong src/ (trừ *.test.ts) không còn lệnh orca terminal send; CHK-1 qua",
      "goalAcceptanceId": "AC-1",
      "checkIds": [
        "CHK-1"
      ]
    },
    {
      "id": "SUP-2",
      "text": "turn_start_unobserved hoặc input_accepted quá hạn sinh notice cho anh, không gửi Enter; CHK-4 chạy trên repo nháp có bằng chứng",
      "goalAcceptanceId": "AC-2",
      "checkIds": [
        "CHK-4"
      ]
    },
    {
      "id": "SUP-3",
      "text": "Escalation hết quota sinh notice và ghi log, không dò màn hình",
      "goalAcceptanceId": "AC-3"
    },
    {
      "id": "SUP-4",
      "text": "Escalation có stopReason sinh notice stopped-without-done ngay; không có escalation thì vẫn báo sau 15 phút idle",
      "goalAcceptanceId": "AC-4"
    },
    {
      "id": "SUP-5",
      "text": "agentWait hoặc waitingOnHuman = true sinh notice waiting-on-human",
      "goalAcceptanceId": "AC-5"
    },
    {
      "id": "SUP-6",
      "text": "Brief Codex chưa gửi được phát hiện qua draft/worker.stage, bỏ regex tail màn hình",
      "goalAcceptanceId": "AC-6"
    },
    {
      "id": "SUP-7",
      "text": "Test SUP-2..SUP-6 dùng fixture 1.4.265 của WP-SIGNALS làm đầu vào và khẳng định đúng notice, không mock chính hàm cần kiểm",
      "goalAcceptanceId": "AC-8"
    },
    {
      "id": "SUP-8",
      "text": "npm run check xanh",
      "goalAcceptanceId": "AC-7",
      "checkIds": [
        "CHK-2"
      ]
    }
  ],
  "integration": "Head của WP-SUPERVISE là commit tích hợp của chuỗi tuần tự (chứa WP-SIGNALS làm tổ tiên); Lead xin integration gate trên commit đó."
}
```
