# Quy ước kiến trúc

Tóm tắt này khớp với code sau đợt 1 của v3. `AGENTS.md` là bản agent đọc; lý do của các quy tắc ban đầu nằm ở [`docs/archive/architecture/convention-refactor-v2.md`](../archive/architecture/convention-refactor-v2.md) (lịch sử, có phần nói về tầng điều phối đã bỏ).

## Tầng và hướng phụ thuộc

```
src/
  domain/   thuần: contracts (zod), transitions (máy trạng thái), gate, packages, reviews, plan,
            legacy-events (tên các sự kiện v2 chỉ còn được đọc), errors
  ports/    chỉ interface: CommitInspector, GoalRepository
  store/    event log nối hash, journal, sqlite (bản chiếu), readonly-journal, lease của gate
  app/      use case: gate-service, package-service (plan + submit), integration, verification, merge,
            registry, inbox, metrics, init-project
  cli/      context (openJournal, assertHuman), human-confirm, commands/<nhóm>.ts
  cli.ts    entry point
  ui/       read model, server, page (chỉ đọc)
```

```
domain  <-  ports  <-  store, app  <-  cli, ui
```

- `domain` không import gì trong `src/`; `ports` chỉ import `domain`; `store` import `domain` và `ports`, không import `app`.
- `app` import `domain`, `ports`, `store`. Phần nối dây nằm ở `cli/`.
- `ui` import `domain`, `ports`, `store/readonly-journal`; ngoại lệ có ghi lại: `app/inbox`.
- Không có vòng import, trừ vòng chỉ có type trong `domain/`.
- Không file nào import `runtime/orca` hay `ports/runtime` (đã xoá). `.dependency-cruiser.cjs` có luật `no-orchestration` giữ điều này.

## Các quy tắc ép bằng máy

`npm run check` chạy: format (Prettier), lint (ESLint, không `any`, không `as unknown as`, `import type`), `deps:check` (dependency-cruiser), typecheck và test. File không phải test không quá 400 dòng; `domain/transitions.ts` là ngoại lệ duy nhất, ghi trong `eslint.config.js`.

## Quy ước còn lại (review tay)

- Tạo event chỉ qua `newEvent()` (`app/events.ts`).
- `UserError` cho sai input hay sai điều kiện trước, `InvariantError` cho vi phạm bất biến; chỉ cho code mới hoặc code đang sửa.
- Dữ liệu từ ngoài vào (file, CLI) đi qua `parseX(value: unknown)` bằng zod.
- Tên file kebab-case, mỗi file một khái niệm; test cạnh code, fixture dùng chung là `*.test-support.ts`.
- Log cũ phải replay được: sự kiện v2 vẫn được đọc nhưng chỉ làm Goal thành `legacy`; `ProjectJournal` từ chối ghi thêm vào Goal legacy và từ chối loại sự kiện không thuộc v3.
