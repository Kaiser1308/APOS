# AGENTS.md

Quy ước cho agent viết code trong APOS. Tóm tắt: `docs/architecture/conventions.md`. Lý do ban đầu (lịch sử): `docs/archive/architecture/convention-refactor-v2.md`.

## Hướng phụ thuộc

```
domain  <-  ports  <-  store, app  <-  cli, ui
```

- `domain` không import gì trong `src/`.
- `ports` chỉ import `domain`.
- `store` import `domain` và `ports`, không import `app`.
- `app` import `domain`, `ports`, `store`. Phần nối dây nằm ở `cli/`.
- `ui` import `domain`, `ports`, `store/readonly-journal`. Ngoại lệ có ghi lại: `app/inbox`.
- Không có `runtime/` hay cổng runtime: APOS v3 không điều phối agent. Không thêm import `runtime/orca` hay `ports/runtime` (depcruise chặn).
- Không có vòng import, trừ vòng chỉ có type trong `domain/`.

Các luật này do dependency-cruiser ép (`.dependency-cruiser.cjs`).

## Đặt code ở đâu

| Loại code | Chỗ đặt |
|---|---|
| Kiểu dữ liệu, zod contract, transitions, gate, packages, reviews, tên sự kiện legacy | `src/domain/` |
| `UserError` (sai input, sai điều kiện trước), `InvariantError` (vi phạm bất biến); chỉ cho code mới hoặc code đang sửa, không đổi hàng loạt `throw new Error` cũ (file đã có, chưa chỗ nào dùng) | `src/domain/errors.ts` |
| Interface cổng (`CommitInspector`, `GoalRepository`) | `src/ports/` |
| Event log, journal, sqlite | `src/store/` |
| Use case (gate, nộp gói, tích hợp, đóng Goal), dựng event bằng `newEvent()` | `src/app/` |
| Lệnh CLI, `openJournal`, `assertHuman` / `confirmHuman` | `src/cli/` (entry point vẫn là `src/cli.ts`) |
| Read model, server, page | `src/ui/` |
| Test | cạnh code (`x.test.ts`); fixture dùng chung là `*.test-support.ts` |

Dữ liệu từ ngoài vào (file, CLI, JSON của Orca) đi qua `parseX(value: unknown)` bằng zod. Tên file kebab-case, mỗi file một khái niệm. Không dùng `any`, không dùng `as unknown as`, dùng `import type` cho type. File không phải test không quá 400 dòng.

## Lệnh

- Chạy `npm run check` trước mỗi commit (format, lint, deps, typecheck, test).
- `npm run format` để tự format.
- Không thêm override mới vào `eslint.config.js` hay `.dependency-cruiser.cjs`; nếu một quy tắc cản việc cần làm, hỏi người dùng.
