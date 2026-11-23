# APOS v3: lớp bảo đảm đầu ra không phụ thuộc LLM

Ngày: 2026-11-22 (bản 2, sau khi chốt lại flow). Người viết: Lead APOS. Trạng thái: **chờ anh duyệt** (item 5).
Nền: repo APOS `main` tại `fb4aa9b`.

## 1. Mục đích

Hệ điều phối agent code thì nhiều. Gần như không cái nào có lớp bảo đảm phần mềm giao ra **đúng tính năng** và **đạt chất lượng**: đa số để chính LLM tự trả lời câu hỏi đó. APOS v3 là lớp bảo đảm ấy, đứng ngoài mọi hệ điều phối.

Đầu ra của mỗi khâu chỉ được tính là đạt khi qua phép kiểm tra cố định do máy chạy, chạy lại vẫn ra cùng kết quả. LLM được viết code, viết test, lập kế hoạch. Nhưng lời LLM nói không bao giờ là bằng chứng.

Người dùng: chỉ anh, cho các dự án của anh. Stack: Python, Java, TypeScript; sắp tới IoT, Rust, Go. Có dự án chung repo nhiều công nghệ, có dự án tách repo.

## 2. Mục tiêu, không làm, phản mục tiêu

**Mục tiêu**
- Chuỗi đúng tính năng máy kiểm được: tài liệu nguồn (có hash) → yêu cầu → tiêu chí Cho trước/Khi/Thì → test chấp nhận viết trước, khoá lại, đỏ trước khi sửa, xanh sau khi sửa.
- Chất lượng theo nhiều lớp test (L0 tới L6), chạy theo khâu. Mức sàn do bộ setup của từng dự án đặt.
- Cắm được công cụ test mới mà không sửa lõi.
- Dùng với bất kỳ hệ điều phối nào; chỉ cần quyền **đọc** repo.
- Mỗi Goal có bảng ghi rõ bảo đảm nào do máy chứng minh, bảo đảm nào anh xác nhận tay, bảo đảm nào tắt.

**Không làm**
- Không điều phối agent (start, đánh thức, đọc màn hình, giữ Run Orca).
- Không làm sản phẩm cho người khác.
- Không dùng GitHub Actions, không cần quyền ghi repo.
- Chưa làm Goal trải trên nhiều repo (để sau; xem 9).
- Không là ranh giới bảo mật trước tiến trình cố ý phá trên cùng máy (giữ mô hình tin cậy hiện có).

**Phản mục tiêu**
- Gate xanh mà phần mềm sai ý anh: test rỗng, test bị xoá, test bị nới, test lệch tiêu chí.
- Lõi phải biết từng ngôn ngữ hoặc từng công cụ.
- Luật đổi giữa chừng Goal mà anh không duyệt.
- Một LLM (Lead, reviewer, công cụ AI) quyết được đạt hay không.

## 3. Ràng buộc

- Một máy (máy anh hoặc server riêng), Node ≥ 24, Windows và Linux.
- Log sự kiện nối hash là nguồn sự thật; sqlite là bản chiếu.
- Hợp đồng Goal, nguồn, bộ setup và test đã khoá được bảo vệ: agent sửa là gate đỏ (mở rộng cơ chế `APOS-PROTECTED` hiện có).
- Không đụng `docs/field-test/` chưa commit của anh.

## 4. Các cách đã cân nhắc

| Quyết định | Các cách | Anh chọn | Lý do |
|---|---|---|---|
| Vai của APOS | giữ điều phối / **chỉ bảo đảm** | chỉ bảo đảm | lỗi mấy tuần qua đều ở tầng điều phối; lớp bảo đảm phải đứng ngoài mọi hệ điều phối |
| Nhiều công nghệ | lõi biết từng ngôn ngữ / preset + định dạng chuẩn / **preset + định dạng chuẩn + script dịch + check tay** | cách thứ ba | lõi gọn, phủ cả dự án lạ |
| Báo commit giao | **Lead submit** / APOS theo dõi nhánh / GitHub Actions | Lead submit, theo dõi nhánh làm sau | không có quyền Actions ở mọi repo |
| Ai viết test chấp nhận | agent code tự viết / **agent viết test riêng, khoá trước khi code** | tách và khoá | người code không nắn được bằng chứng |
| Khi nào viết test | theo từng gói / **một lần cho cả Goal** | một lần cho cả Goal | lộ vênh giữa các gói sớm; L3 cần thấy mọi cửa |
| Ai chốt cửa công khai | agent viết test / **Lead trong kế hoạch** | Lead | các gói ghép qua đúng cửa đó |
| Ai chọn lớp test | chỉ setup / chỉ Lead / **setup đặt sàn, Lead thêm** | sàn + Lead thêm | Lead linh hoạt, sàn vẫn do anh |
| Sửa test đã khoá | anh duyệt mọi lần / **anh duyệt khi bớt assert** | khi bớt assert | thêm tham số mà giữ assert thì máy tự cho qua |
| Công cụ AI | trọng tài / **chỉ sinh test hoặc tìm lỗi kèm test đỏ** | chỉ hai vai đó | giữ nguyên tắc máy phán |
| Nhiều repo | Goal cha + con / một Goal nhiều repo / **để sau** | để sau | hiếm khi cần |

## 5. Flow

```
0. Dự án vào APOS (một lần)
   Lead đọc repo → nhận ra stack → tra danh mục công cụ → nháp project.yaml
   APOS chạy thử từng lệnh → ► anh duyệt → khoá

1. Anh + PM agent → Goal
   Tiêu chí Cho trước/Khi/Thì; mỗi yêu cầu khai kiểu bằng chứng
   Máy: mọi yêu cầu có tiêu chí hoặc bị loại kèm lý do; không còn câu hỏi mở
   ► anh duyệt Goal (+ ngân sách, cờ như perf/mutation)

2. Lead → kế hoạch
   Mỗi gói: tiêu chí nhận, cửa công khai, đường dẫn được sửa, lớp test thêm
   Máy: tiêu chí nào cũng thuộc một gói; lớp Lead chọn có trong setup; sàn tự cộng

2b. Agent viết test → bộ test cả Goal
   L2 cho mọi tiêu chí + khung rỗng của cửa; L3; L4/L5 nếu có
   Máy: mọi test chạy được, ĐỎ vì đúng lý do, chỉ gọi qua cửa đã khai → KHOÁ

3. Agent code từng gói (song song được) → Lead: apos package submit
   Code + L1 tự do
   Máy (gate): test khoá XANH, kiểm kê đủ, đúng phạm vi, L0, lớp khâu submit
   Đỏ → lý do trả về Lead; sửa là việc của hệ điều phối

4. Ghép gói
   Máy: L1 + L2 toàn Goal + L3 + lớp kích hoạt

5. Trước khi đóng
   Máy: toàn bộ test không lỗi mới so với base + L4/L5 theo cờ; anh xác nhận L6
   ► anh xem bảng mức bảo đảm → outcome close (chỉ khi commit cuối đã qua gate)
```

Anh chỉ can thiệp ở: duyệt setup, duyệt Goal, duyệt ngoại lệ (bớt lớp sàn, sửa file nhạy cảm, test bị bớt assert, xoá test), xác nhận L6, đóng Goal.

## 6. Thiết kế chi tiết

### 6.1 Bỏ, giữ, thêm

| Bỏ (tầng điều phối) | Giữ | Thêm |
|---|---|---|
| `runtime/orca/*` | `domain/contracts`, `domain/transitions` (rút gọn) | danh mục công cụ + bộ setup v2 |
| `app/controller*`, `solo-supervisor`, `multi-supervisor`, `supervision`, `watch`, `wait` (phần chờ agent) | `domain/gate`, `app/gate-service`, `app/gate-workspace` | đọc JUnit XML, SARIF, số đo, JSON APOS |
| `app/lead` (dispatch), `bot-lead`, `bot-wake-check`, `lead-transfer`, `handoff`, `solo` | `store/*` (log nối hash, journal, sqlite, lease) | khâu 2b: khoá test |
| `runtime/screens`, nudge, `runtime/brief` | `app/protected-milestones` | lớp test L0 tới L6, luật kích hoạt |
| CLI `controller tick/watch`, `lead start/wake`, `handoff`, `profile`, `execution start/resume/reconcile` | cửa Human, `ui`, `inbox`, `plan`, `goal *`, `lead propose/commit`, `package add/revise/remove`, `integration *` | `apos setup *`, `apos tests submit/lock`, `apos package submit` |
| đọc transcript agent cho `metrics` | | bảng mức bảo đảm |

### 6.2 Các lớp test

| Lớp | Là gì | Ai viết | Bằng chứng? |
|---|---|---|---|
| L0 Tĩnh | typecheck, lint, mẫu cấm, quét | – (công cụ) | chất lượng |
| L1 Nội bộ | unit test hàm con | agent code, khâu 3 | không (nhưng không được xoá) |
| L2 Chấp nhận | hành vi theo tiêu chí, qua cửa công khai | agent viết test, khâu 2b, khoá | **có** |
| L3 Ghép nối | giữa các gói/module, DB và hàng đợi thật trong container | agent viết test, khâu 2b, khoá | có |
| L4 Đầu-cuối | qua giao diện hoặc toàn hệ thống | agent viết test, khâu 2b, khoá | có |
| L5 Phi chức năng | hiệu năng (ngưỡng anh duyệt), bảo mật, mutation | công cụ, ngưỡng trong Goal/setup | có |
| L6 Tay / phần cứng | anh xác nhận trên đúng commit | anh | có (ghi là xác nhận tay) |

Lớp chạy mặc định theo khâu (sàn, có thể chỉnh trong setup):

| Khâu | Chạy |
|---|---|
| 2b khoá test | L0 trên file test + mọi test vừa viết (phải đỏ đúng lý do) |
| 3 submit gói | L0 + L1 + L2 của gói + kiểm kê + phạm vi |
| 4 ghép | L1 + L2 toàn Goal + L3 |
| 5 trước khi đóng | toàn bộ, không lỗi mới + L4 + L5 theo cờ + L6 |

Luật kích hoạt (trong setup) kéo một lớp lên khâu sớm hơn theo file bị sửa hoặc cờ của Goal, ví dụ sửa `src/ui/**` thì chạy e2e ngay lúc submit. Lead thêm lớp cho từng gói trong kế hoạch. Bớt một lớp sàn cần anh duyệt trên đúng gói đó.

### 6.3 Kiểu bằng chứng của yêu cầu

Mặc định mỗi yêu cầu chức năng cần ≥ 1 test L2. Yêu cầu phi chức năng khai `proof` trong Goal: `benchmark` (lệnh + ngưỡng), `scan` (công cụ SARIF + mức chặn), `manual` (thủ tục + kết quả mong đợi, anh xác nhận). Tiêu chí refactor có thể khai `stays-green` (xanh cả trước lẫn sau) nếu anh duyệt.

### 6.4 Khâu 2b: viết và khoá test

- `apos tests submit <goal> --commit <sha>`: commit chứa test L2/L3/L4 và khung rỗng của mọi cửa đã khai.
- Máy kiểm:
  1. Mỗi tiêu chí có ≥ 1 test được gắn, gắn qua id test trong `proofTests`, do agent viết test khai trong một file map nằm trong commit.
  2. Mọi test có mặt trong báo cáo (chạy được).
  3. Mọi test **đỏ vì đúng lý do**: assertion sai hoặc lỗi "chưa làm" từ khung rỗng. Lỗi biên dịch, lỗi import, lỗi nạp test thì không tính. Mẫu nhận ra "chưa làm" khai theo stack trong danh mục, ví dụ `NotImplementedError` hay `UnsupportedOperationException`.
  4. Diff chỉ chứa file test, file khung rỗng của cửa đã khai, và file map.
  5. Test chỉ gọi qua cửa đã khai. Kiểm theo mức danh mục cho phép, ví dụ cấm import module nội bộ ngoài cửa. Stack nào chưa có luật thì ghi "chưa kiểm" trên bảng.
- Đạt thì `apos tests lock`: hash từng file test cùng số assert (đếm bằng mẫu assert của stack) được ghi vào log. Từ đó các file này được bảo vệ.

**Sửa test đã khoá** (vì đổi cửa công khai): Lead sửa cửa trong kế hoạch, agent viết test nộp bản mới. Máy kiểm bản mới vẫn đỏ trên code cũ, vẫn gắn đúng tiêu chí, và giữ đủ id test. Số assert không giảm thì máy tự khoá lại. Số assert giảm hoặc có test bị xoá thì chờ anh duyệt, kèm diff.

### 6.5 Gate

Trên base và delivery trong worktree sạch, như hiện nay. Base của mọi gói là commit đã khoá test ở khâu 2b; các gói rẽ nhánh từ commit đó.

1. **Test đã khoá:** đúng hash (không bị sửa); xanh trên delivery; mỗi test chạy `runs` lần, kết quả lệch nhau là `unverifiable`.
2. **Kiểm kê:** tập id test trên delivery ⊇ trên base; `skip`/`only` hay mẫu `forbid` mới thêm là đỏ.
3. **Phạm vi:** file ngoài `paths` của gói là đỏ; file khớp `needsHuman` thì `needs-human`.
4. **Các lớp của khâu**, theo sàn + Lead thêm + luật kích hoạt.

Gate trả `green | red | needs-human | unverifiable`, kèm lý do cho từng mục, ghi vào log.

### 6.6 Danh mục công cụ và bộ setup

**Danh mục** (`~/.apos/catalog/<stack>.yaml`, đi kèm APOS): với mỗi stack, mỗi lớp có công cụ gợi ý, lệnh, định dạng ra, mẫu assert, mẫu "chưa làm", luật nhận ra cửa công khai. LLM được sửa và thêm thoải mái, vì danh mục **không có giá trị bảo đảm**.

Stack đợt đầu: `python`, `java-gradle`, `java-maven`, `typescript`. Đợt sau: `go`, `rust`, `iot-platformio`, `iot-c`.

**Bộ setup** (`.apos/project.yaml` schemaVersion 2, được bảo vệ): đây là thứ duy nhất quyết gate chạy gì.

```yaml
schemaVersion: 2
parts:                                  # một phần nếu repo một công nghệ
  backend:
    root: backend/
    catalog: java-gradle
    layers:
      L0: [{ id: checkstyle, command: "./gradlew checkstyleMain", format: sarif, report: "{report}" }]
      L1: { command: "./gradlew test --tests '*Unit*'", format: junit, report: "build/test-results/**/*.xml" }
      L2: { command: "./gradlew test --tests '*Acceptance*'", runOne: "./gradlew test --tests '{id}'", format: junit }
      L5: [{ id: pit, command: "./gradlew pitest", format: metric, metric: mutationScore, min: 70, when: flag:mutation }]
    needsHuman: [build.gradle, settings.gradle]
  frontend:
    root: frontend/
    catalog: typescript
    layers: { ... }
system:
  L4: { command: "npx playwright test", format: junit }
floor:                                  # sàn theo khâu (mặc định như 6.2)
  submit: [L0, L1, L2]
triggers:
  - { when: { changed: ["frontend/src/ui/**"] }, at: submit, run: [system.L4] }
```

Gate chỉ chạy lớp của những phần bị sửa; lớp `system` chạy ở khâu ghép và trước khi đóng.

Vòng đời: `apos setup draft` (Lead viết từ danh mục) → `apos setup probe` (chạy thật: ra kết quả đọc được, `runOne` ra đúng một test, hai lần chạy cùng kết quả) → `apos setup approve` (**Human**) → khoá. Mỗi Goal ghim phiên bản setup lúc `goal approve`. Đổi setup thì tạo phiên bản mới và duyệt lại.

### 6.7 Cắm công cụ mới

Hợp đồng duy nhất: chạy bằng một lệnh, ra một trong bốn định dạng:
- **`junit`**: JUnit XML;
- **`sarif`**: SARIF, kèm mức chặn;
- **`metric`**: một con số, so với ngưỡng;
- **`apos-json`**: `{"items":[{"id","status":"pass|fail|skip","detail"}]}`.

Công cụ không xuất được các định dạng trên thì dùng script dịch nằm trong danh mục, viết một lần dùng cho mọi dự án. Thêm công cụ: vào danh mục → Lead đề xuất sửa setup → probe → anh duyệt. Không sửa lõi.

**Công cụ AI** chỉ có hai vai:
1. Sinh test: test đó đi qua khâu 2b như mọi test khác.
2. Tìm lỗi: chặn được khi nộp kèm một test đỏ máy chạy lại được.

Công cụ chạy hai lần ra hai kết quả khác nhau bị probe loại khỏi vai trọng tài.

### 6.8 Review LLM

Không còn là điều kiện qua cửa. Reviewer, kể cả công cụ AI, chỉ chặn được một gói khi nộp commit test đặt trên delivery, và test đó đỏ khi controller chạy. Test chặn hợp lệ được khoá và thành bằng chứng bắt buộc cho lần giao sau. Nhận xét không kèm test chỉ là góp ý.

### 6.9 Bảng mức bảo đảm

```
GOAL-X  setup v3  (backend: java-gradle, frontend: typescript)
  Tiêu chí           14   máy chứng minh 12 · anh xác nhận tay 2
  Test đã khoá       L2 31 · L3 6 · L4 3      sửa sau khoá: 1 (máy tự duyệt)
  Kiểm kê / phạm vi  bật
  L0                 checkstyle, eslint, tsc
  L5                 perf p95<2s ✓ · mutation tắt (Goal không gắn cờ)
  Ngoại lệ anh duyệt bớt L4 ở WP-DOCS; sửa build.gradle ở WP-API
  Chưa kiểm          "test chỉ gọi qua cửa" ở frontend (danh mục chưa có luật)
```

Hiện ở `apos ui`, `goal list`, và trong tài liệu Goal được commit ở các mốc.

### 6.10 Ngân sách, telemetry

Bỏ `--max-spend` vì không đo được chi phí khi APOS không chạy agent. Giữ:
- `--max-minutes`: từ `goal select` tới lúc verified;
- `--max-attempts`: số lần submit bị đỏ trên mỗi gói.

`metrics` chỉ còn số lần submit và thời gian.

## 7. Duyệt và cách làm (anh đã chốt)

1. **Mặc định của setup:** bản nháp bật sẵn sàn chặt (mẫu cấm theo stack, mutation `minScore: 70` khi Goal gắn cờ), anh nới theo dự án.
2. **Goal G3:** dừng và lưu trữ trước khi bắt đầu đợt 1 (`outcome stop GOAL-G3`, chỉ chạy khi anh bấm nút trên item). Log G3 vẫn đọc được.
3. **Ai duyệt cái gì:**

   | Anh giữ | Agent (Lead) được duyệt thay |
   |---|---|
   | Duyệt Goal (tiêu chí, ngân sách, cờ) | Sửa test đã khoá bị bớt assert hoặc xoá test |
   | Đóng Goal | Bớt lớp sàn cho một gói |
   | Duyệt setup lần đầu của dự án | Sửa file `needsHuman` (dependency, cấu hình build) |
   | Xác nhận L6 (tay/phần cứng) | Sửa setup về sau (thêm công cụ, thêm lớp) |

   - Mọi lần agent duyệt thay đều được ghi vào log với người duyệt là `agent:<tên>`, và hiện trên bảng mức bảo đảm ("agent duyệt thay: n chỗ", kèm danh sách).
   - Lệnh của anh phải xác nhận tương tác: gõ lại id trong terminal có TTY, hoặc bấm trên `apos ui`.
   - Luật "em chạy thay anh khi anh bấm nút cho đúng lệnh đó trên item" vẫn giữ, có cờ `--on-behalf "item <n>"` ghi vào log.
4. **Cách làm:** sửa ngay trên repo APOS theo năm đợt ở mục 10, mỗi đợt một PR (repo dùng merge commit, không xoá nhánh). Test hiện có của gate, log và hợp đồng phải xanh suốt quá trình, làm lưới an toàn cho phần lõi.

## 8. Để lại cho người làm (em quyết, anh xem lại nếu muốn)

- Trạng thái còn lại sau khi rút gọn:
  - Goal: `draft → approved → selected → planned → tests-locked → executing → verified → closed`;
  - gói: `pending → submitted → green | red | needs-human`.
- Log cũ vẫn đọc được qua `apos ui`, không chạy tiếp.
- Trích dẫn `{changed}`, `{id}` an toàn trên Windows và Linux.
- Fault-injection cho từng bảo đảm: xoá test, test xanh từ đầu, test đỏ vì lỗi import, sửa test đã khoá, bớt assert, sửa ngoài phạm vi, sửa setup, công cụ chạy không ổn định.
- Đếm assert bằng mẫu regex theo stack. Đây là kiểm tra thô, có mutation làm lưới thứ hai khi được bật.

## 9. Để sau

- Goal trải trên nhiều repo (hướng: Goal cha + Goal con mỗi repo + repo test hệ thống).
- APOS tự theo dõi nhánh thay cho Lead submit.
- Stack Go, Rust, IoT trong danh mục.

## 10. Chia đợt (lập kế hoạch sau khi duyệt)

1. Bỏ tầng điều phối; rút gọn máy trạng thái; `package submit`; đóng Goal yêu cầu commit cuối đã qua gate.
2. Định dạng kết quả (junit, sarif, metric, apos-json); danh mục đợt đầu (python, java, typescript); setup v2 với draft/probe/approve, ghim theo Goal, chia phần.
3. Khâu 2b (tests submit/lock, đỏ đúng lý do, sửa test đã khoá) và bảo đảm kiểm kê, phạm vi.
4. Lớp L0 tới L6 theo khâu, sàn + Lead thêm + luật kích hoạt; kiểu bằng chứng phi chức năng; bảng mức bảo đảm.
5. Review và công cụ AI chặn bằng test đỏ; mutation.
