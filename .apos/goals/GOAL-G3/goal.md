# GOAL-G3 v2: APOS biết trạng thái agent bằng tín hiệu chính thức của Orca, không đọc màn hình terminal và không gõ vào agent

Status: ready

```json
{
  "id": "GOAL-G3",
  "version": 2,
  "outcome": "APOS biết trạng thái agent bằng tín hiệu chính thức của Orca, không đọc màn hình terminal và không gõ vào agent",
  "source": {
    "path": "C:/Users/thien/.orca/bots/forge/drafts/G3/brief.md",
    "sha256": "217fb8f8e5e43084eda2f25e16ec195a44c222bb349734eb67bf81e5594a2e72",
    "capturedAt": "2026-11-21T10:05:36.454Z",
    "origin": "human"
  },
  "requirements": [
    {
      "id": "R-1",
      "sourceSpan": "mục 1",
      "text": "Bỏ tự nhấn Enter vào terminal agent; lượt chưa bắt đầu thì báo anh",
      "disposition": "acceptance"
    },
    {
      "id": "R-2",
      "sourceSpan": "mục 2",
      "text": "Biết hết quota qua escalation của Orca, không dò màn hình",
      "disposition": "acceptance"
    },
    {
      "id": "R-3",
      "sourceSpan": "mục 3",
      "text": "Biết agent dừng không báo xong qua escalation có stopReason; giữ lưới idle 15 phút",
      "disposition": "acceptance"
    },
    {
      "id": "R-4",
      "sourceSpan": "mục 4",
      "text": "Agent chờ câu hỏi chỉ người trả lời được thì báo anh",
      "disposition": "acceptance"
    },
    {
      "id": "R-5",
      "sourceSpan": "mục 5",
      "text": "Brief Codex dán chưa gửi: dò bằng draft hoặc worker.stage, không regex màn hình",
      "disposition": "acceptance"
    },
    {
      "id": "R-6",
      "sourceSpan": "mục 6",
      "text": "Hành vi khác của APOS giữ nguyên",
      "disposition": "acceptance"
    },
    {
      "id": "R-7",
      "sourceSpan": "mục 7",
      "text": "Test của owner phải được kiểm là thật sự thử đúng tín hiệu Orca",
      "disposition": "acceptance"
    }
  ],
  "scope": [
    "src/app/supervision.ts",
    "src/app/watch.ts",
    "src/runtime/screens.ts",
    "src/runtime/orca/adapter.ts",
    "src/runtime/orca/parse.ts",
    "src/ports/runtime.ts (chỉ mở rộng RuntimeObservation/RuntimeAdapter bằng các trường quan sát tín hiệu Orca: stage, agentWait, waitingOnHuman, stopReason, quotaExhausted, draft; không đổi hành vi khác)",
    "các file test và fixture tương ứng",
    "src/runtime/README.md"
  ],
  "exclusions": [
    "không đổi domain/transitions, gate-service hay luật cổng Human",
    "không thêm dependency mới",
    "không làm G4 (chép inbox sang item), G5, G6"
  ],
  "acceptance": [
    {
      "id": "AC-1",
      "text": "Trong src/ (trừ *.test.ts) không còn lệnh gọi terminal send",
      "requirementIds": [
        "R-1"
      ],
      "examples": [],
      "boundaries": [],
      "prohibited": [
        "không gửi phím hoặc text vào terminal của agent bằng bất kỳ lệnh orca terminal nào"
      ],
      "checkIds": [
        "CHK-1"
      ]
    },
    {
      "id": "AC-2",
      "text": "worker.stage = turn_start_unobserved (hoặc input_accepted quá hạn) sinh notice cho anh, không gửi Enter",
      "requirementIds": [
        "R-1"
      ],
      "examples": [],
      "boundaries": [],
      "prohibited": [],
      "checkIds": [
        "CHK-2",
        "CHK-4",
        "CHK-5"
      ]
    },
    {
      "id": "AC-3",
      "text": "Escalation hết quota của Orca sinh notice và ghi log; không đọc màn hình để dò quota",
      "requirementIds": [
        "R-2"
      ],
      "examples": [],
      "boundaries": [],
      "prohibited": [],
      "checkIds": [
        "CHK-2",
        "CHK-5"
      ]
    },
    {
      "id": "AC-4",
      "text": "Escalation có stopReason sinh notice stopped-without-done ngay; idle 15 phút vẫn còn làm lưới an toàn",
      "requirementIds": [
        "R-3"
      ],
      "examples": [],
      "boundaries": [
        "không có escalation thì vẫn báo sau 15 phút idle như hiện tại"
      ],
      "prohibited": [],
      "checkIds": [
        "CHK-2",
        "CHK-5"
      ]
    },
    {
      "id": "AC-5",
      "text": "observation.agentWait hoặc waitingOnHuman = true sinh notice waiting-on-human cho anh",
      "requirementIds": [
        "R-4"
      ],
      "examples": [],
      "boundaries": [],
      "prohibited": [],
      "checkIds": [
        "CHK-2",
        "CHK-5"
      ]
    },
    {
      "id": "AC-6",
      "text": "Brief Codex chưa gửi được phát hiện qua trường draft hoặc worker.stage, không dùng regex trên tail màn hình",
      "requirementIds": [
        "R-5"
      ],
      "examples": [],
      "boundaries": [],
      "prohibited": [],
      "checkIds": [
        "CHK-2",
        "CHK-5"
      ]
    },
    {
      "id": "AC-7",
      "text": "Toàn bộ kiểm tra hiện có của repo vẫn qua",
      "requirementIds": [
        "R-6"
      ],
      "examples": [],
      "boundaries": [],
      "prohibited": [],
      "checkIds": [
        "CHK-2"
      ]
    },
    {
      "id": "AC-8",
      "text": "Test cho AC-2 đến AC-6 dựng đầu vào là JSON tín hiệu Orca thật hoặc fixture bắt từ Orca 1.4.265, và khẳng định đúng notice sinh ra",
      "requirementIds": [
        "R-7"
      ],
      "examples": [],
      "boundaries": [],
      "prohibited": [],
      "checkIds": [
        "CHK-5"
      ]
    }
  ],
  "checks": [
    {
      "id": "CHK-1",
      "kind": "command",
      "command": "node -e \"const fs=require('fs'),p=require('path');const bad=[];const walk=d=>{for(const f of fs.readdirSync(d)){const x=p.join(d,f);if(fs.statSync(x).isDirectory())walk(x);else if(/[.]ts$/.test(f)&&!/[.]test[.]ts$/.test(f)&&/terminal.,[ ]*.send/.test(fs.readFileSync(x,'utf8')))bad.push(x)}};walk('src');if(bad.length){console.error(bad.join(' '));process.exit(1)}\"",
      "expect": "pass",
      "runs": 1,
      "timeoutMs": 600000,
      "env": {}
    },
    {
      "id": "CHK-2",
      "kind": "command",
      "command": "npm run check",
      "expect": "pass",
      "runs": 1,
      "timeoutMs": 1800000,
      "env": {}
    },
    {
      "id": "CHK-4",
      "kind": "manual",
      "procedure": "Trên repo nháp (không phải APOS thật): dispatch một worker mà lượt chưa bắt đầu (worker.stage = turn_start_unobserved), chạy controller vài tick",
      "expectedResult": "Anh nhận notice trong apos inbox; log không có lệnh terminal send nào; worker không bị gõ Enter"
    },
    {
      "id": "CHK-5",
      "kind": "manual",
      "procedure": "Reviewer (và anh khi duyệt cổng D) đọc test mới cho AC-2 đến AC-6",
      "expectedResult": "Mỗi test dựng tín hiệu Orca thật hoặc fixture 1.4.265 làm đầu vào và khẳng định đúng notice; không có test chỉ mock hàm cần kiểm để cho xanh"
    }
  ],
  "dependencies": [],
  "priority": 1
}
```
