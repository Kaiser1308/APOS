> **Lưu trữ (lịch sử).** Kế hoạch tái cấu trúc của APOS v2 (có `runtime/orca`, supervisor, `ports/runtime`). Các chuẩn còn hiệu lực nằm ở [`../../architecture/conventions.md`](../../architecture/conventions.md).

# Kiến trúc: thống nhất convention và dọn code APOS

Trạng thái: Đã duyệt (2026-11-14) · Đã triển khai (2026-11-16)

## 1. Lý do và mục tiêu đo được

Code APOS chủ yếu do agent viết. Agent không tự nhớ convention, nên mỗi lượt lại thêm một kiểu, và repo chưa có công cụ nào chặn lại. Mục tiêu là dọn những chỗ đang làm chậm các thay đổi sắp tới, và để máy giữ chuẩn thay cho người review.

Mục tiêu đo được, kiểm trên CI:

| Chỉ số | Hiện tại | Đích |
|---|---|---|
| Ép kiểu `runtimeRef as …` ngoài `domain/` | 34 | 0 |
| Chỗ tự dựng event `{ id: randomUUID(), goalId, … }` | 32 chỗ / 14 file | 1 helper |
| Vòng import giữa các tầng | 1 (runtime ↔ app) | 0, CI chặn |
| Dòng code > 120 ký tự ngoài chuỗi và comment | hàng trăm (33 dòng > 200 chỉ riêng `cli-app.ts`) | 0, Prettier lo |
| File không phải test > 400 dòng đã đếm (bỏ dòng trống và comment) | 4 (`orca` 519, `supervisor` 507, `cli-app` 489, `transitions` 464) | 0; `domain/transitions.ts` là ngoại lệ duy nhất có ghi lý do |
| Lint / format / kiểm phụ thuộc / CI | không có | chạy bắt buộc trên mỗi push |
| Hành vi | 283 test pass | vẫn 283+ test pass, event log cũ replay ra đúng trạng thái cũ |

## 2. Chẩn đoán

**Phạm vi đã đọc:** import tương đối của mọi file `src/**/*.ts` (trừ fixtures); đọc kỹ các file sửa nhiều nhất trong 90 ngày: `cli-app.ts` (38 lần), `runtime/orca.ts` (36), `domain/transitions.ts` (29), `app/supervisor.ts` (24), `app/controller.ts` (21). Thêm README (mục Development, Known limits), `bugs.md`, `docs/superpowers/plans/2026-11-14-*.md`, cùng kết quả `git branch` và `git worktree`. **Chưa đọc kỹ:** từng hàm trong `ui/`, `store/`, `runtime/brief.ts`. Các chuẩn bên dưới vẫn áp cho những thư mục này, nhưng phần dọn không đụng tới chúng.

| # | Quan sát | `path:dòng` | Tác động lên thay đổi | Nguồn |
|---|---|---|---|---|
| O1 | `GoalState.runtimeRef`, `blocker`, `checkpoint` và `PackageState.runtimeRef` có kiểu `unknown`, nên app phải ép kiểu tay 34 chỗ | `domain/transitions.ts:16,25,29,30`; `app/controller.ts:139,187-197,233`; `app/gate.ts:120,154` | Mọi thay đổi về dispatch, như owner Claude/Antigravity hay Multi-WP chạy thật, đều phải sửa những chỗ ép kiểu này mà compiler không kiểm | đo |
| O2 | Vòng import runtime ↔ app. Interface cổng nằm rải rác: `RuntimeAdapter` trong `runtime/orca.ts:31`, `PackageRuntime` trong `app/packages.ts:11`, `CommitInspector` trong `app/integration.ts:11`, `TelemetryProbe` trong `runtime/telemetry.ts:6` | `runtime/orca.ts:7` ↔ `app/packages.ts:7` | Muốn thêm hoặc sửa adapter agent thì phải phụ thuộc ngược vào app. Agent cũng không biết đặt interface mới vào đâu | đo |
| O3 | Câu dựng event chép ở 32 chỗ trong 14 file | `cli-app.ts:67`, `app/packages.ts:21`, … | Đổi cấu trúc event phải sửa 32 chỗ, và agent tiếp tục chép thêm | đo |
| O4 | `runCli` gói 68 lệnh, import 27 module, và chứa cả `assertHuman` | `cli-app.ts:42,70` | File sửa nhiều nhất. Mỗi lệnh mới đều đụng file này, nên các agent làm song song dễ conflict | đo (churn); conflict là giả định |
| O5 | `SoloSupervisor` và `MultiSupervisor` chung một file; `orca.ts` gồm adapter cộng khoảng 15 hàm parse và git | `app/supervisor.ts:33,294`; `runtime/orca.ts:65-188` | Sửa Multi-WP phải đọc qua cả Solo; sửa parse phải đọc qua cả adapter | đo |
| O6 | Không có linter, formatter hay CI; dòng dài tới hơn 200 ký tự | gốc repo, `package.json`, không có `.github/` | Không có gì chặn agent viết lệch chuẩn; diff khó review | đo |
| O7 | Chỉ dùng `Error` thường (238 chỗ), riêng `OrcaRefused` là lớp lỗi riêng | `runtime/orca.ts:86` | CLI không phân biệt được lỗi do người dùng với lỗi bất biến (xem BUG-3 ở mục 8) | `bugs.md` |
| O8 | `transitions.ts` là một `switch` với 52 case | `domain/transitions.ts:89` | Hiện vẫn đọc được | **chưa chứng minh tác động**, không dọn |
| O9 | Vòng type trong domain: `transitions` ↔ `gate`/`reviews` | `domain/gate.ts:3`, `domain/reviews.ts:2` | Chỉ là import type | **chưa chứng minh tác động**, không dọn |
| O10 | UI import `runtime/orca` (`worktreePath`) và `app/inbox` | `ui/activity.ts:5`, `ui/read-model.ts:6` | Chỉ đọc | **chưa chứng minh tác động**, ghi thành ngoại lệ |
| O11 | Trùng tên file: `domain/gate.ts`/`app/gate.ts`, `domain/packages.ts`/`app/packages.ts` | | Dễ nhầm khi tìm file | lời anh (đánh giá trước); tác động nhẹ |

## 3. Ràng buộc

| Mục | Trạng thái | Cách đóng |
|---|---|---|
| Team | **Đã biết** (lời anh): code chủ yếu do agent viết | Quy tắc phải ép bằng máy và nằm trong `AGENTS.md` mà agent đọc được |
| Thời gian | **Đã biết** (anh theo đề xuất): 1–2 ngày công, không dừng tính năng | Chia đợt nhỏ, mỗi đợt một commit |
| Test | **Đã biết:** 283 test, 41 file, có fault-injection (`docs/fault-injection.md`) | Refactor thường, không cần `refactor-wave`. Riêng việc replay log cũ **chưa có test** → thêm đợt ghim Đ3a |
| Hợp đồng không được đổi | **Đã biết:** định dạng event log JSONL phải replay được (README, mục Known limits); tên lệnh, cờ và output CLI (có test khóa); `bin: dist/cli.js` (`package.json`) | Không đổi JSON trên đĩa. `src/cli.ts` vẫn là entry point |
| Tính năng sắp làm | **Đã biết** (anh theo đề xuất, bỏ phần giới hạn tiền): Multi-WP chạy trên Goal thật, owner Claude/Antigravity chạy live | Cả hai đi qua `runtime/`, `controller`, `supervisor`, đúng chỗ của O1, O2, O5 |
| Kênh ghi mới (HTTP API, UI có nút) | **Giả định không chặn:** không có trong kế hoạch. Nếu sau này có thì phải lên bậc 2 (mục 4), nhưng các đợt bậc 1 dưới đây vẫn giữ nguyên vì đó là bước chuẩn bị cần có | Xem lại khi có yêu cầu |
| Nhánh song song | **Đã biết:** chỉ có `main`, không có worktree khác | Reformat toàn repo một lần không sợ conflict |
| Tải, triển khai | **Giả định không chặn:** công cụ chạy trên một máy, nên bậc 3 bị loại với mọi mức tải | |

Không có câu chặn nào còn mở.

## 4. Quyết định

**Cần tái cấu trúc bậc 1** (dọn trong module), kèm **một chỉnh ranh giới hẹp** cho O2.

- Bậc 1 đủ cho O1, O3, O4, O5: các tầng domain/store/runtime/app/ui đang đúng, chỗ cản nằm trong từng module.
- O2 không sửa được bằng bậc 1 vì vòng import đi qua hai tầng. Cách sửa hẹp nhất là gom kiểu dữ liệu ref xuống `domain/` và gom interface cổng vào `src/ports/`. Không đổi trách nhiệm của tầng nào.
- O8, O9, O10 không dọn vì chưa chứng minh tác động.

**Lên bậc 2 khi:** cần thêm một kênh ghi thứ hai ngoài CLI. Khi đó tách `cli/` thành use-case dùng chung và chuyển `assertHuman` xuống tầng app. **Xem lại `transitions.ts` khi:** vượt 600 dòng hoặc hơn 70 loại event.

## 5. Kiến trúc đích

```
src/
  domain/      thuần: contracts (zod), transitions, gate, packages, reviews,
               runtime-refs.ts   ← MỚI: RuntimeRef, PackageRuntimeRef, RuntimeProfile (chỉ dữ liệu)
               errors.ts         ← MỚI: UserError, InvariantError
  ports/       ← MỚI: chỉ interface: RuntimeAdapter, PackageRuntime, CommitInspector, TelemetryProbe, GoalRepository(type)
  store/       event log, journal, sqlite, readonly-journal
  runtime/     orca/adapter.ts, orca/parse.ts, orca/git.ts, brief, screens, telemetry
  app/         events.ts (newEvent) ← MỚI; solo-supervisor.ts, multi-supervisor.ts; gate-service.ts, package-service.ts, …
  cli/         context.ts (openJournal, assertHuman), commands/<nhóm>.ts
  cli.ts       entry point (giữ đường dẫn cho bin)
  ui/          read model, server, page
```

**Hướng phụ thuộc** (mũi tên chỉ hướng được phép import):

```
domain  ←  ports  ←  store, runtime, app  ←  cli, ui
```

- `domain` không import gì trong `src/`.
- `ports` chỉ import `domain`.
- `runtime` và `store` import `domain` và `ports`, không import `app`.
- `app` import `domain`, `ports`, `store`, `runtime`. Phần nối dây nằm ở `cli/`.
- `ui` import `domain`, `ports`, `store/readonly-journal`; **ngoại lệ có ghi lại:** `app/inbox` và `runtime/orca` (`worktreePath`) theo O10.
- Không có vòng import nào giữa các file, trừ vòng type trong `domain/` (O9) đang được cho phép.

**Chỗ nối cho tính năng sắp làm:** adapter agent mới (Claude, Antigravity) cài đặt `ports/runtime.ts`; Multi-WP sửa trong `multi-supervisor.ts` mà không đụng phần Solo.

## 6. Chuẩn chung và cách ép

| Quy tắc | Phạm vi | Cách ép | Trạng thái |
|---|---|---|---|
| Hướng phụ thuộc như mục 5, không vòng import | `src/` | dependency-cruiser (`.dependency-cruiser.cjs`), `npm run deps:check` | đề xuất, chưa kiểm (1 devDep, khoảng 1h viết config) |
| Format: Prettier, `printWidth: 120`, single quote | toàn repo | `npm run format:check` | đề xuất, chưa kiểm |
| Không `any`, không `as unknown as`, dùng `import type` cho type | `src/` | ESLint flat config + typescript-eslint: `no-explicit-any`, `consistent-type-imports`, cấm `as unknown as` bằng `no-restricted-syntax` | đề xuất, chưa kiểm |
| File không phải test ≤ 400 dòng | `src/` | ESLint `max-lines` mức error; ngoại lệ `domain/transitions.ts` ghi ngay trong config kèm lý do (O8) | đề xuất, chưa kiểm |
| Tạo event chỉ qua `newEvent()` / `record()` | `app/`, `cli/` | ESLint `no-restricted-syntax` chặn object literal có cả `id: randomUUID()` và `goalId` ngoài `app/events.ts` | đề xuất, chưa kiểm |
| Interface cổng mới đặt trong `ports/`; kiểu dữ liệu ref đặt trong `domain/runtime-refs.ts` | `src/` | dependency-cruiser (runtime không import app) và review | máy + review tay |
| Tên file kebab-case, mỗi file một khái niệm; service ở app đặt tên `*-service.ts` khi trùng tên với domain | `src/` | review tay | chỉ review tay |
| Test đặt cạnh code (`x.test.ts`), fixture dùng chung trong `*.test-support.ts` | `src/` | đã có trong `tsconfig.json` (`exclude`) | đã có |
| Lỗi do người dùng (sai input, sai điều kiện trước) ném `UserError`; vi phạm bất biến ném `InvariantError`; **chỉ áp cho code mới hoặc code đang sửa**, không đổi hàng loạt 238 chỗ | `src/` | review tay | chỉ review tay |
| Dữ liệu từ ngoài vào (file, CLI, Orca JSON) đi qua `parseX(value: unknown)` bằng zod | `domain/`, `runtime/` | đã thành nếp (`domain/contracts.ts`); review tay | chỉ review tay |
| Mọi kiểm ở trên chạy trên CI: format, lint, deps, typecheck, test | mỗi push và PR | `.github/workflows/ci.yml`, chạy `windows-latest` với Node 24 | đề xuất, chưa kiểm |
| Agent đọc chuẩn trước khi viết code | repo | `AGENTS.md` (và `CLAUDE.md` trỏ tới) ở gốc repo tóm tắt mục 5–6 cùng lệnh kiểm | đề xuất, chưa kiểm |

## 7. Các đợt triển khai (chỉ việc giữ nguyên hành vi)

Lệnh kiểm chung sau mỗi đợt: `npm run typecheck && npm test`, cộng các lệnh đã thêm ở đợt trước. Mỗi đợt là một commit `refactor:` hoặc `chore:`.

| Đợt | Phạm vi | Điều kiện xong | Rủi ro | Cách quay lại | Công | Cần xong trước (7b) |
|---|---|---|---|---|---|---|
| Đ0 | Thêm Prettier, reformat toàn repo, ghi hash commit vào `.git-blame-ignore-revs` | `format:check` xanh, 283 test pass, diff không có thay đổi logic | Diff lớn, nhưng không có nhánh song song | `git revert` | 1h | — |
| Đ1 | ESLint, dependency-cruiser, CI, `AGENTS.md`. Vi phạm hiện có (O2, các file > 400 dòng, `cli-app.ts:5`, `transitions.ts:443`) tạm vào danh sách ngoại lệ để CI xanh ngay | CI xanh trên `main`; danh sách ngoại lệ ghi rõ đợt nào sẽ gỡ | Thêm devDep; CI Windows chạy chậm (test mất khoảng 74s) | revert commit | 2–3h | — |
| Đ2 | Tạo `domain/runtime-refs.ts` (chuyển `RuntimeRef`, `PackageRuntimeRef`, `RuntimeProfile` sang) và `ports/` (chuyển 4 interface sang). Gỡ ngoại lệ O2 | `deps:check` không còn vòng runtime ↔ app; không file nào đổi logic | Nhiều file đổi import | revert | 1–2h | — |
| Đ3a | **Ghim hành vi replay:** test replay vài event log thật (đã xóa dữ liệu nhạy cảm, lấy từ `~/.apos/projects/*/events`, gồm Solo, Multi-WP, handoff, review) rồi snapshot `GoalState` | Test mới pass trên code hiện tại | Log mẫu có thể chứa đường dẫn máy → phải làm sạch | xóa test | 1h | — |
| Đ3 | Gán kiểu cho `GoalState.runtimeRef`, `PackageState.runtimeRef`, `blocker` (theo `PackageBlocker`), `lead.ref.requested`. Thu hẹp kiểu tại **một chỗ** trong `transitions.ts`, không thêm zod strict (để log cũ vẫn replay). Xóa 34 chỗ ép kiểu | grep `runtimeRef as` ngoài domain = 0; snapshot Đ3a không đổi | Lỡ thêm validate làm log cũ fail khi replay → Đ3a sẽ bắt | revert | 2–3h | — |
| Đ4 | `app/events.ts` với `newEvent(goalId, type, data?)`, thay 32 chỗ; bật luật ESLint chặn tự dựng event | grep pattern = 0; test pass | Thứ tự `id`/`at` trong JSON có thể đổi, nhưng không ảnh hưởng replay | revert | 1h | — |
| Đ5 | Tách `cli-app.ts` thành `cli/context.ts` và `cli/commands/{goal,lead,package,controller,review,outcome,ui,…}.ts`; `cli.ts` và `runCli` giữ nguyên chữ ký | Mỗi file ≤ 400 dòng; `cli.test.ts`, `cli-friendly.test.ts` pass không cần sửa | Thứ tự đăng ký lệnh commander làm đổi output `--help` → so output help trước và sau | revert | 3h | — |
| Đ6 | Tách `supervisor.ts` thành `solo-supervisor.ts`, `multi-supervisor.ts` và helper dùng chung; tách `orca.ts` thành `runtime/orca/{adapter,parse,git}.ts` | Các file ≤ 400 dòng; gỡ ngoại lệ `max-lines` (trừ `transitions`) | Test import đường dẫn cũ → sửa import, không dùng barrel file | revert | 2–3h | — |
| Đ7 | Đổi tên `app/gate.ts` thành `gate-service.ts`, `app/packages.ts` thành `package-service.ts` (O11) | grep không còn import tên cũ | Thấp | revert | 0.5h | — |

**Tổng:** khoảng 14–18h, vừa 1–2 ngày công. Nếu thiếu thời gian thì cắt theo thứ tự Đ7, rồi Đ6. Không cắt Đ0–Đ4 vì đó là phần chặn code dơ thêm và gỡ cản trở cho tính năng sắp làm.

**Xếp với tính năng:** Đ0–Đ3 nên xong trước khi bắt đầu Multi-WP thật hoặc owner Claude/Antigravity live, vì cả hai đụng `runtimeRef` và adapter. Đ5–Đ7 có thể làm song song với tính năng, nhưng tránh làm cùng lúc với việc đang sửa đúng file đó. Thiết kế chi tiết tính năng giao `pm-design`; công làm tính năng không tính vào thời gian dọn.

### Kết quả triển khai

Cả 10 task của plan đã xong trên nhánh `refactor/conventions`.

Khác với plan:

- Thêm module: `src/app/supervision.ts` (helper dùng chung của hai supervisor), `src/app/controller-notices.ts`, `src/runtime/orca/{exec,packages,handoff}.ts`.
- `OrcaRuntime` được tách qua interface `OrcaContext`.
- Prettier ghim ở 3.9.10; các công cụ lint ghim vào bản phát hành cũ hơn 14 ngày.
- Fixture replay phủ legacy-solo, legacy-solo-v1, multi-wp và lead, **chưa** phủ handoff và blocker.

Việc theo dõi tiếp:

- `multi-supervisor.ts` và `solo-supervisor.ts` đang ở sát giới hạn 400 dòng đã đếm. Lần sửa Multi-WP tới nên tách `wakeLead` ra module riêng trước.
- Lần chạy GitHub CI đầu tiên chưa được kiểm chứng (chưa push gì).
- Hai luật `no-restricted-syntax` (`as unknown as` và dựng event thủ công) dùng chung một key, nên override theo file phải liệt kê lại selector không muốn tắt. Test được miễn cả hai.

## 7b. Pha sửa lỗi phải xong trước khi mở kênh

Không có. Chưa có lỗi nào bị các thay đổi sắp tới khuếch đại.

## 8. Lỗi phát hiện (không thuộc phần dọn)

| Mã | Lỗi | Nguồn | Hệ quả | Chặn | Giao |
|---|---|---|---|---|---|
| L1 | Lỗi zod in nguyên JSON thô ra CLI (BUG-3) | `bugs.md`; `cli.ts` bắt `ZodError` | UX kém | không | sửa thường, có test. Nên làm sau Đ1 để dùng `UserError` |
| L2 | `reviewDispatch` ép kiểu `as unknown as`, không kiểm dữ liệu khi replay | `domain/transitions.ts:443` | Event hỏng đi qua mà không bị phát hiện | không | sửa thường. Đ3 chỉ gỡ cách ép kiểu, không thêm validate |
| L3 | BUG-1: owner chết, Goal treo `executing` | `bugs.md` | Goal kẹt im lặng | không | xác minh plan `2026-11-14-github-issues-fixes.md` đã đóng chưa |

## 9. Điều chưa chắc

| Điều | Cách xác minh | Ai quyết | Chặn |
|---|---|---|---|
| Chọn dependency-cruiser hay `eslint-plugin-boundaries` | Thử ở Đ1; lấy cái nào cho thông báo lỗi rõ hơn cho agent | lựa chọn của em: dependency-cruiser, vì kiểm được cả vòng import lẫn hướng tầng trong một công cụ | không |
| Prettier đổi output của file `ui/page.ts` (HTML/CSS nằm trong template string) | Prettier không format nội dung template string; kiểm diff ở Đ0 | em | không |
| Có đủ event log thật để ghim ở Đ3a không | Liệt kê `~/.apos/projects/*/events/*.jsonl` | anh cho phép dùng log trên máy | không: thiếu thì dựng log từ fixture |
| `printWidth` 120 hay 100 | Anh muốn khác thì đổi một dòng | anh | không |

## 10. Bàn giao

- Vùng này đã có test đủ (283 test, cộng thêm Đ3a), nên **refactor thường**, không dùng `refactor-wave`: lập plan từ mục 7 bằng `superpowers:writing-plans`, rồi thi công theo từng đợt bằng `superpowers:subagent-driven-development`.
- Trước Đ6 chạy `npx vitest run --coverage`. File nào phủ dưới 60% thì chỉ riêng file đó đi qua `refactor-wave`.
- Tính năng Multi-WP thật và owner Claude/Antigravity → `pm-design`, sau khi xong Đ3.
- Việc chọn chiều phụ thuộc `domain ← ports ← …` khó đảo ngược, nên có thể ghi ADR qua `domain-modeling` nếu anh muốn.
