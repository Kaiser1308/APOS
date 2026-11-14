# BÁO CÁO KIỂM THỬ VÀ DÙNG THỬ HỆ THỐNG APOS (QA/QC TEST REPORT)

* **Dự án:** APOS (AI Project Orchestration System)
* **Phiên bản:** v0.1.0
* **Vai trò thực hiện:** QA/QC Tester
* **Ngày thực hiện:** 12/11/2026
* **Môi trường thử nghiệm:**
  - **Hệ điều hành:** Windows 11 (x64)
  - **Node.js:** v24.22.1
  - **Git:** 2.55.0.windows.3
  - **Orca CLI:** 1.4.255
  - **Codex CLI:** 0.167.0
  - **Model cấu hình:** `luna` (Codex)

---

## 1. MỤC TIÊU & PHẠM VI KIỂM THỬ (TEST OBJECTIVES & SCOPE)

### 1.1 Mục tiêu
1. **Kiểm tra tính toàn vẹn bản dựng (Build & Static Analysis):** Xác minh TypeScript biên dịch sạch, không lỗi kiểu (`typecheck`, `build`).
2. **Kiểm tra hồi quy tự động (Automated Regression Test Suite):** Chạy toàn bộ 31 test suites (195 test cases) để đánh giá độ ổn định và phát hiện flaky test trên môi trường Windows.
3. **Thực nghiệm toàn trình vòng đời Goal (E2E Lifecycle Testing):**
   - Khởi tạo dự án (`apos init`).
   - Quản lý Goal: soạn thảo (`goal create`), duyệt chỉ tiêu và appetite ngân sách (`goal approve` - Gate A), chọn Goal ưu tiên (`goal select` - Gate B).
   - Lập kế hoạch Lead: đề xuất phương án (`lead propose`), chốt kế hoạch và dispatch (`lead commit`).
   - Tương tác Runtime Orca & Agent Codex: quan sát tạo worktree, nhận diện thông điệp orchestration `worker_done`.
   - Cơ chế bảo vệ Cổng quyết định (`assertHuman`): kiểm tra nghiêm ngặt việc ngăn chặn Agent tự phê duyệt.
   - Hoàn tất và đóng Goal (`outcome close` - Gate D).
4. **Kiểm tra cấu hình Runtime:** Đảm bảo hệ thống tuân thủ cấu hình chỉ sử dụng model **`luna`** cho Codex.

---

## 2. MA TRẬN KIỂM THỬ & KẾT QUẢ TỔNG HỢP (TEST MATRIX)

| Mã kiểm thử | Hạng mục / Tính năng | Mô tả kịch bản kiểm thử | Mức ưu tiên | Kết quả | Ghi chú |
| :--- | :--- | :--- | :---: | :---: | :--- |
| **TC-01** | **Môi trường & Prerequisite** | Kiểm tra Node.js >= 24, Git, Orca CLI và Codex | P0 | **PASS** | Đủ điều kiện môi trường |
| **TC-02** | **Static Typecheck** | `npm run typecheck` (`tsc --noEmit`) | P0 | **PASS** | 0 lỗi TypeScript |
| **TC-03** | **Package Build** | `npm run build` (`tsc`) | P0 | **PASS** | Biên dịch ra `dist/` thành công |
| **TC-04** | **Skills Management** | `npm run skills:check` và `npm run skills:promote` | P2 | **FAIL** | Lỗi thiếu tham số (Bug #2) |
| **TC-05** | **Automated Suite Run** | Chạy toàn bộ test suites (`vitest run`) | P0 | **FAIL (Flaky)** | 194/195 pass; timeout tại `merge.test.ts` (Bug #1) |
| **TC-06** | **Project Init & Idempotency**| Khởi tạo `.apos` trên Git repo mới, chạy lại lần 2 | P0 | **PASS** | Tạo đủ `.apos/`, `.claude/`; chạy lại an toàn |
| **TC-07** | **Goal Creation & Digest** | `goal create --file ... --source ...`, kiểm tra sha256 | P1 | **PASS** | Snapshot source và băm sha256 chính xác |
| **TC-08** | **Gate A (Human Approval)** | `goal approve` kèm appetite (size, maxSpend, minutes) | P0 | **PASS** | Kiểm tra validation đầy đủ |
| **TC-09** | **Gate B (Lead & Selection)**| `lead recommend` và `goal select` | P1 | **PASS** | Chuyển trạng thái sang `selected` |
| **TC-10** | **Lead Planning Validation** | `lead propose` với plan thiếu trường vs plan hợp lệ | P1 | **PASS** | Zod schema bắt lỗi chính xác |
| **TC-11** | **Dispatch & Orca Lifecycle**| `lead commit` sinh isolated worktree & dispatch worker | P0 | **PASS** | Dispatch ID `ctx_4ad255b02e0b` thành công |
| **TC-12** | **Orchestration Handling** | Nhận và xử lý message `worker_done` từ Orca | P0 | **PASS** | Run `run_ffe9128d297b` hoàn tất `succeeded` |
| **TC-13** | **Security Gate (`assertHuman`)**| Chặn lệnh Human-only khi chạy từ terminal của agent | P0 | **PASS** | Trả về lỗi và exit code 1 chuẩn xác |
| **TC-14** | **Gate D Enforcement** | Chặn `outcome close` khi Goal chưa verified | P0 | **PASS** | Từ chối đóng khi chưa đủ bằng chứng |
| **TC-15** | **Model Pinning (luna)** | Cấu hình Codex chỉ sử dụng model `luna` | P1 | **PASS** | Đã áp dụng `runtime.json` & `config.toml` |

---

## 3. NHẬT KÝ CHI TIẾT CÁC LỖI & BẤT CẬP PHÁT HIỆN ĐƯỢC (BUG LOGS)

### Bug #1: `src/app/merge.test.ts` bị Timeout (5000ms) trong lượt chạy song song trên Windows
* **Phân loại:** Flaky Test / Concurrency I/O Timeout
* **Mức độ nghiêm trọng:** Medium
* **Vị trí file:** `vitest.config.ts` và `src/app/merge.test.ts:14`
* **Mô tả lỗi:** Khi thực thi kiểm thử toàn bộ dự án bằng `npm test` (`vitest run`), có 30/31 test files vượt qua (194 tests pass), duy nhất `src/app/merge.test.ts` bị FAIL do vượt quá thời gian chờ mặc định 5000ms của Vitest.
* **Log chi tiết:**
  ```text
  FAIL  src/app/merge.test.ts > merges only the gated commit, only after the Human authorizes that one merge
  Error: Test timed out in 5000ms.
  If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
   ❯ src/app/merge.test.ts:14:1
  Test Files  1 failed | 30 passed (31)
  Tests  1 failed | 194 passed (195)
  ```
* **Đặc tính tái hiện:** Khi chạy đơn lập file này (`npx vitest run src/app/merge.test.ts`), test case chạy thành công chỉ trong 1.4 giây (1403ms). Lỗi chỉ xảy ra khi chạy toàn bộ test suite do tranh chấp tài nguyên CPU/Disk I/O của Git subprocess trên Windows.
* **Đề xuất xử lý:**
  1. Thêm `testTimeout: 20000` vào `vitest.config.ts`.
  2. Hoặc bổ sung timeout tường minh cho test case: `it('merges only the gated commit...', async () => { ... }, 15000);`.

---

### Bug #2: `npm run skills:check` gặp lỗi thoát (Exit Code 1) khi không có biến môi trường
* **Phân loại:** CLI / Script Ergonomics Bug
* **Mức độ nghiêm trọng:** Low
* **Vị trí file:** `package.json` (dòng 13) và `scripts/promote-skills.mjs` (dòng 19)
* **Mô tả lỗi:** Lệnh script tiêu chuẩn được định nghĩa trong `package.json` là `"skills:check": "node scripts/promote-skills.mjs --check"`. Tuy nhiên khi người dùng hoặc dev chạy `npm run skills:check`, script bị crash ngay lập tức vì script yêu cầu bắt buộc tham số `<dev skills dir>` hoặc biến môi trường `APOS_DEV_SKILLS`.
* **Log chi tiết:**
  ```text
  > apos@0.1.0 skills:check
  > node scripts/promote-skills.mjs --check

  Usage: promote-skills [--check] [--to <stable dir>] <dev skills dir>  (or set APOS_DEV_SKILLS)
  ```
* **Đề xuất xử lý:** Cập nhật script kiểm tra mặc định thư mục `./skills` nội bộ nếu không có tham số ngoài, hoặc hiển thị hướng dẫn rõ ràng trong tài liệu/npm script.

---

### Điểm bất cập #3: Cảnh báo Git Line Ending (CRLF vs LF) xuất hiện diện rộng trên Windows
* **Phân loại:** Environment / Cleanliness Observation
* **Mức độ:** Trivial
* **Mô tả:** Trong quá trình chạy test và tương tác với Git, liên tục xuất hiện hàng chục cảnh báo:
  `warning: in the working copy of 'fail.txt', LF will be replaced by CRLF the next time Git touches it`
* **Đề xuất xử lý:** Bổ sung file `.gitattributes` ở thư mục gốc với nội dung `* text=auto eol=lf` để chuẩn hóa toàn bộ file sang LF, tránh làm nhiễu log output.

---

## 4. XÁC MINH ORCHESTRATION & CẤU HÌNH RUNTIME CODEX (MODEL LUNA)

### 4.1 Orchestration Message Verification
* Đã thực hiện kiểm tra run ID `run_ffe9128d297b`:
  - Lệnh: `orca orchestration check --run run_ffe9128d297b`
  - Nhận message: `msg_68259d54666f` (Type: `worker_done`)
  - Báo cáo hoàn tất: Worker đã commit triển khai `slugify`, vượt qua kiểm thử `node --test` và nộp báo cáo evidence hợp lệ theo hợp đồng của APOS.

### 4.2 Cấu hình Codex chỉ dùng model `luna`
Đã thiết lập model `luna` cố định ở 2 tầng:
1. **APOS Controller Runtime:** Tạo file `C:\Users\thien\.apos\projects\apos-2b3de11b559d\runtime.json`:
   ```json
   {
     "lead": { "agent": "codex", "model": "luna" },
     "worker": { "agent": "codex", "model": "luna" },
     "reviewer": { "agent": "codex", "model": "luna" }
   }
   ```
2. **Cấu hình toàn cục Codex:** Cập nhật `~/.codex/config.toml`:
   - `model = "luna"`
3. **Thực nghiệm xác nhận:** Chạy thử `orca agent launch --agent codex --model luna` thành công, runtime ghi nhận hợp lệ.

---

## 5. KẾT LUẬN & ĐÁNH GIÁ CỦA QA/QC

1. **Chất lượng kiến trúc:** APOS sở hữu kiến trúc phân quyền rất chặt chẽ. Cơ chế State Machine, Hash-chained Journal và `assertHuman` hoạt động cực kỳ tin cậy, ngăn chặn triệt để tình trạng agent tự tung tự tác phê duyệt công việc của chính mình.
2. **Độ sẵn sàng sử dụng:** Hệ thống đã sẵn sàng cho quy trình điều phối agent thực tế.
3. **Việc cần làm trước đợt release tiếp theo:**
   - [ ] Nâng `testTimeout` trong `vitest.config.ts` lên 20s để giải quyết dứt điểm Bug #1.
   - [ ] Thêm file `.gitattributes` để chuẩn hóa định dạng xuống dòng trên Windows.
   - [ ] Cải thiện xử lý tham số trong `scripts/promote-skills.mjs` cho lệnh `npm run skills:check`.
