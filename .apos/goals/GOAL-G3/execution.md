# PROP-G3 v2: multi-wp

Hai WP tuần tự. WP-SIGNALS: adapter/parse đọc các tín hiệu chính thức của Orca 1.4.265 từ worker-show và escalation (worker.stage, observation.agentWait, waitingOnHuman, stopReason, escalation hết quota, trường draft) thành một quan sát có kiểu, kèm fixture JSON bắt thật từ 1.4.265; chưa đổi hành vi giám sát. WP-SUPERVISE: supervision/watch dùng quan sát đó để sinh notice (lượt chưa bắt đầu, hết quota, stopped-without-done, waiting-on-human, brief Codex chưa gửi), bỏ hết orca terminal send và regex màn hình trong screens.ts, giữ lưới idle 15 phút, cập nhật src/runtime/README.md và chạy CHK-4 trên repo nháp. Goal v2 đã thêm src/ports/runtime.ts vào scope: WP-SIGNALS mở rộng RuntimeObservation/RuntimeAdapter bằng các trường tín hiệu. WP-SIGNALS bắt đầu từ phần đã làm ở v1 (commit c310ae5 trên nhánh Kaiser1308/apos-goal-g3-wp-signals-7c2b4bb7: parse tín hiệu và fixture thật).

```json
{
  "id": "PROP-G3",
  "version": 2,
  "goalId": "GOAL-G3",
  "goalVersion": 2,
  "mode": "multi-wp",
  "approach": "Hai WP tuần tự. WP-SIGNALS: adapter/parse đọc các tín hiệu chính thức của Orca 1.4.265 từ worker-show và escalation (worker.stage, observation.agentWait, waitingOnHuman, stopReason, escalation hết quota, trường draft) thành một quan sát có kiểu, kèm fixture JSON bắt thật từ 1.4.265; chưa đổi hành vi giám sát. WP-SUPERVISE: supervision/watch dùng quan sát đó để sinh notice (lượt chưa bắt đầu, hết quota, stopped-without-done, waiting-on-human, brief Codex chưa gửi), bỏ hết orca terminal send và regex màn hình trong screens.ts, giữ lưới idle 15 phút, cập nhật src/runtime/README.md và chạy CHK-4 trên repo nháp. Goal v2 đã thêm src/ports/runtime.ts vào scope: WP-SIGNALS mở rộng RuntimeObservation/RuntimeAdapter bằng các trường tín hiệu. WP-SIGNALS bắt đầu từ phần đã làm ở v1 (commit c310ae5 trên nhánh Kaiser1308/apos-goal-g3-wp-signals-7c2b4bb7: parse tín hiệu và fixture thật).",
  "risks": [],
  "baseCommit": "844b62c6d6102d8b86d6ee8627e425a8ff09e261",
  "sourceSha256": "217fb8f8e5e43084eda2f25e16ec195a44c222bb349734eb67bf81e5594a2e72",
  "estimatedCost": {
    "spendUsd": 14,
    "wallMinutes": 210
  },
  "splitRationale": "Đọc tín hiệu Orca (adapter, fixture thật) và đổi hành vi giám sát là hai việc có ranh giới rõ; tách ra để WP sau làm trên một giao diện tín hiệu đã verified bằng fixture 1.4.265, và mỗi phiên giữ ngữ cảnh nhỏ. Đây cũng là pilot Multi-WP tuần tự với Lead là bot.",
  "sharedPaths": [
    "src/runtime/orca/adapter.ts",
    "src/runtime/orca/parse.ts",
    "src/ports/runtime.ts"
  ],
  "acceptanceMapping": [
    {
      "acceptanceId": "AC-1",
      "verification": "WP-SUPERVISE xoá mọi orca terminal send khỏi src/ (trừ test); CHK-1 do controller chạy."
    },
    {
      "acceptanceId": "AC-2",
      "verification": "WP-SIGNALS đọc worker.stage; WP-SUPERVISE sinh notice cho turn_start_unobserved/input_accepted quá hạn, test dựng từ fixture 1.4.265; CHK-2, CHK-4 trên repo nháp, CHK-5."
    },
    {
      "acceptanceId": "AC-3",
      "verification": "WP-SIGNALS nhận diện escalation hết quota; WP-SUPERVISE sinh notice và ghi log, không đọc màn hình; CHK-2, CHK-5."
    },
    {
      "acceptanceId": "AC-4",
      "verification": "WP-SIGNALS đọc stopReason của escalation; WP-SUPERVISE sinh notice stopped-without-done ngay, giữ idle 15 phút khi không có escalation; CHK-2, CHK-5."
    },
    {
      "acceptanceId": "AC-5",
      "verification": "WP-SIGNALS đọc observation.agentWait/waitingOnHuman; WP-SUPERVISE sinh notice waiting-on-human; CHK-2, CHK-5."
    },
    {
      "acceptanceId": "AC-6",
      "verification": "WP-SIGNALS đọc trường draft/worker.stage; WP-SUPERVISE dò brief Codex chưa gửi bằng trường đó, bỏ regex tail màn hình; CHK-2, CHK-5."
    },
    {
      "acceptanceId": "AC-7",
      "verification": "Mỗi WP chạy npm run check xanh; controller chạy CHK-2 trên commit tích hợp."
    },
    {
      "acceptanceId": "AC-8",
      "verification": "Fixture JSON thật bắt từ Orca 1.4.265 nằm trong WP-SIGNALS; test của WP-SUPERVISE dùng chính fixture đó làm đầu vào và khẳng định notice; reviewer kiểm theo CHK-5.",
      "level": "goal"
    }
  ],
  "verificationStrategy": "Controller chạy CHK-1 và CHK-2 trên head từng WP và trên commit tích hợp (head của WP-SUPERVISE, chuỗi tuần tự). CHK-4 do Worker WP-SUPERVISE chạy trên repo nháp trong scratchpad và nộp bằng chứng; Lead kiểm bằng chứng trước khi xin gate tích hợp. CHK-5 do reviewer độc lập của Goal đọc test."
}
```
