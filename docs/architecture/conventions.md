# Quy ước kiến trúc

Tóm tắt này khớp với code hiện tại. `AGENTS.md` là bản agent đọc; lý do của các quy tắc ban đầu nằm ở [`docs/archive/architecture/convention-refactor-v2.md`](../archive/architecture/convention-refactor-v2.md) (lịch sử, có phần nói về tầng điều phối đã bỏ).

## Tầng và hướng phụ thuộc

```
domain  <-  ports  <-  store, app  <-  cli, ui
```

- `domain` không import gì trong `src/`; `ports` chỉ import `domain`; `store` import `domain` và `ports`, không import `app`.
- `app` import `domain`, `ports`, `store`. Phần nối dây nằm ở `cli/`.
- `ui` import `domain`, `ports`, `store/readonly-journal`; ngoại lệ có ghi lại: `app/inbox`.
- Không có vòng import, trừ vòng chỉ có type trong `domain/`.
- Không file nào import `runtime/orca` hay `ports/runtime` (đã xoá): APOS không điều phối agent. `.dependency-cruiser.cjs` có luật `no-orchestration` giữ điều này.

## Module nằm ở đâu

**`src/domain/`** (thuần, không I/O):

| Nhóm | File |
|---|---|
| Hợp đồng và máy trạng thái | `contracts` (zod), `transitions` (áp sự kiện lên `GoalState`, kể cả khoá test, ngoại lệ, review chặn), `goal-flags` (cờ của Goal, như `mutation`), `plan`, `packages`, `reviews`, `errors` |
| Cổng và bằng chứng | `gate` (kết quả kiểm, tổng hợp), `integration-gate`, `close-gate`, `assurance` (khoá test, kiểm kê, phạm vi, test hạ tầng, test của review), `assurance-report` (bảng mức bảo đảm), `exceptions` (loại ngoại lệ và ai được duyệt), `entry-rule`, `proof-tools`, `run-one`, `threshold` |
| Lớp kiểm thử | `layers` (L0 đến L6), `layer-plan` (lớp nào chạy ở khâu nào), `layer-verdict` (đọc kết quả một lớp: junit, sarif, metric, exit) |
| Định dạng kết quả | `results/` (`junit`, `sarif`, `apos-json`, `metric`, `failures`, `load-errors`, `xml-lite`, `types`) |
| Setup và catalog | `catalog` (schema của danh mục công cụ), `project-setup` (setup của dự án), `setup-codec` (YAML/JSON), `setup-history`, `glob` |
| Test của review | `review-tests` (khoá của review chặn), `test-lock` (khoá test của tester) |
| Log cũ | `legacy-events` (tên sự kiện v2, chỉ còn được đọc) |

**`src/ports/`**: chỉ interface: `CommitInspector`, `GoalRepository`.

**`src/store/`**: `event-log` (log nối hash), `journal` (một Goal), `project-log` và `project-history` (log của dự án: setup), `sqlite` (bản chiếu), `readonly-journal` (cho UI), `lease` (khoá một gate tại một thời điểm).

**`src/app/`** (use case):

| Nhóm | File |
|---|---|
| Cổng | `gate-service`, `gate-workspace` (worktree sạch), `package-service` (plan, nộp gói), `integration`, `close-gate`, `verification`, `merge`, `protected-milestones` |
| Lớp và bằng chứng | `layer-gate` (chạy các lớp của một khâu và phán), `layer-runner` (chạy một công cụ trong worktree sạch), `assurance-service` (khoá test, kiểm kê, phạm vi, khoá review), `report-files`, `shell-executor`, `source-files` (file nguồn đổi, cho mutation) |
| Setup | `catalog-loader`, `setup-draft`, `setup-probe`, `setup-approve`, `pinned-setup` |
| Review và ngoại lệ | `review-block` (`review block`/`review note`), `exceptions` |
| Còn lại | `registry`, `inbox`, `metrics`, `init-project`, `events` (`newEvent()`), `git-files`, `wait` |

**`src/cli/`**: `context` (`openJournal`, `assertHuman`), `human-confirm`, `options`, `lead-layers`, `lock-summary`, `commands/<nhóm>.ts` (`goal`, `lead`, `package`, `integration`, `outcome`, `review`, `setup`, `setup-flow`, `checks`). Entry point là `src/cli.ts`.

**`src/ui/`** (chỉ đọc): `read-model`, `story`, `server`, `page`. Xem [`docs/design/apos-ui.md`](../design/apos-ui.md).

**Mutation** không có module riêng: đó là công cụ L5 của setup có `when: flag:mutation` (danh mục `catalog/*.yaml`), do `app/layer-gate` chạy hai lần và so với `mutation.minScore`.

## Các quy tắc ép bằng máy

`npm run check` chạy: format (Prettier), lint (ESLint, không `any`, không `as unknown as`, `import type`), `deps:check` (dependency-cruiser), typecheck và test. File không phải test không quá 400 dòng; `domain/transitions.ts` là ngoại lệ duy nhất, ghi trong `eslint.config.js`.

## Quy ước còn lại (review tay)

- Tạo event chỉ qua `newEvent()` (`app/events.ts`).
- `UserError` cho sai input hay sai điều kiện trước, `InvariantError` cho vi phạm bất biến; chỉ cho code mới hoặc code đang sửa.
- Dữ liệu từ ngoài vào (file, CLI) đi qua `parseX(value: unknown)` bằng zod.
- Tên file kebab-case, mỗi file một khái niệm; test cạnh code, fixture dùng chung là `*.test-support.ts`.
- Log cũ phải replay được: sự kiện v2 vẫn được đọc nhưng chỉ làm Goal thành `legacy`; `ProjectJournal` từ chối ghi thêm vào Goal legacy và từ chối loại sự kiện không thuộc v3.
