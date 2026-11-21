# WP-SIGNALS v1: Adapter Orca đọc các tín hiệu chính thức của Orca 1.4.265 về trạng thái agent thành một quan sát có kiểu, có fixture JSON bắt thật; hành vi giám sát chưa đổi.

```json
{
  "id": "WP-SIGNALS",
  "goalId": "GOAL-G3",
  "goalVersion": 1,
  "version": 1,
  "owner": "worker",
  "outcome": "Adapter Orca đọc các tín hiệu chính thức của Orca 1.4.265 về trạng thái agent thành một quan sát có kiểu, có fixture JSON bắt thật; hành vi giám sát chưa đổi.",
  "scope": [
    "src/runtime/orca/adapter.ts",
    "src/runtime/orca/parse.ts",
    "test và fixture tương ứng (src/runtime/fixtures/orca-1.4.265)"
  ],
  "exclusions": [
    "không đổi src/app/supervision.ts, src/app/watch.ts, src/runtime/screens.ts (việc của WP-SUPERVISE)",
    "không đổi domain/transitions, gate-service, luật cổng Human",
    "không thêm dependency",
    "không sửa src/ports/runtime.ts; nếu cần thì hỏi Lead"
  ],
  "dependencies": [],
  "interfaces": [
    "agent-signals@v1: quan sát có kiểu gồm stage (worker.stage), agentWait, waitingOnHuman, stopReason, quotaExhausted, draft (brief chưa gửi), lấy từ worker-show --full và escalation của Run"
  ],
  "acceptance": [
    {
      "id": "SIG-1",
      "text": "Parse đúng worker.stage (gồm turn_start_unobserved, input_accepted), observation.agentWait, waitingOnHuman và draft từ fixture worker-show --full bắt thật trên 1.4.265",
      "goalAcceptanceId": "AC-2"
    },
    {
      "id": "SIG-2",
      "text": "Nhận diện escalation hết quota và escalation có stopReason từ fixture thư Orca bắt thật",
      "goalAcceptanceId": "AC-3"
    },
    {
      "id": "SIG-3",
      "text": "agent-signals@v1 trả stopReason cho escalation dừng không báo xong",
      "goalAcceptanceId": "AC-4"
    },
    {
      "id": "SIG-4",
      "text": "agent-signals@v1 trả agentWait/waitingOnHuman",
      "goalAcceptanceId": "AC-5"
    },
    {
      "id": "SIG-5",
      "text": "agent-signals@v1 trả trạng thái brief chưa gửi từ trường draft hoặc worker.stage, không dùng màn hình",
      "goalAcceptanceId": "AC-6"
    },
    {
      "id": "SIG-6",
      "text": "npm run check xanh",
      "goalAcceptanceId": "AC-7",
      "checkIds": [
        "CHK-2"
      ]
    }
  ],
  "integration": "WP-SUPERVISE dùng agent-signals@v1 làm đầu vào duy nhất cho trạng thái agent và dùng lại fixture 1.4.265 của WP này trong test."
}
```
