# Thiết kế chốt: APOS v2 — quản lý việc cho agent theo khối, gate bằng máy

> Trạng thái: **đã ký** — claude ĐỒNG Ý; sol ĐỒNG Ý CÓ SỬA (r3-sol.md), 6 sửa đã áp ngày 2026-11-08.
> **Sửa đổi v2.1 (2026-11-08, theo anh):** tách hai tầng — PM cùng anh quyết *làm cái gì / cái nào trước*; Lead tự quyết *làm thế nào*, kể cả có chia WP không. Anh không duyệt Execution Proposal; Lead chọn Multi-WP thì controller **báo** anh (không chờ duyệt). Cổng của anh: A duyệt Goal, B chọn Goal, D nghiệm thu (bỏ C). Sol xác nhận ở `r4-sol.md` (3 sửa đã áp); đối chiếu thêm `APOS_PROJECT_OVERVIEW (2).md` của anh.

Người viết: claude + sol, qua 4 vòng debate (r1–r4). Cơ sở: thí nghiệm Hard12 2026-11-06 (gọi tắt EB; tài liệu thí nghiệm không nằm trong repo này) và APOS bản v1 lúc đó (31 commit, 84 test xanh, đã có smoke Solo và Multi-WP thật).

**Một câu:** giữ khung điều khiển của APOS, vì nó đã đúng hướng; bổ sung tầng làm ra độ đúng gồm nguồn yêu cầu bất biến, acceptance có ca biên và phép kiểm, gate do máy chạy, và kỷ luật thực thi trong skill; rồi đo trước khi tin.

---

## 0. Trả lời câu anh hỏi: điều gì bảo đảm một khối làm đúng?

Không lớp nào bảo đảm tuyệt đối. Cách làm là xếp nhiều lớp độc lập để một hiểu sai không lọt qua tất cả:

| Lớp | Chặn lỗi gì | Đặt ở đâu |
| --- | --- | --- |
| 1. Nguồn yêu cầu nguyên văn + map từng yêu cầu | brief tóm tắt làm rơi yêu cầu (EB C1: mất giới hạn 55 s) | hợp đồng Goal, gate duyệt |
| 2. Acceptance có ví dụ, ca biên, luật giao nhau, phép kiểm | agent đoán sai chỗ đặc tả im lặng (EB C2: cả hai nhánh trượt hai ca CLI; nhánh team trượt thêm ba ca ReuseValues) | hợp đồng Goal/WP; PM hỏi anh trước khi giao |
| 3. Kỷ luật thực thi: tự review toàn diff như người ngoài, kiểm lại từ đầu, không làm xanh giả | owner tự lừa mình, tuyên bố xong sớm | lõi skill `_core/execute.md` |
| 4. Gate máy: controller tự chạy check trên đúng commit, so fail base/head | evidence tự khai "pass" | controller |
| 5. Review độc lập theo rủi ro | lỗi thiết kế mà test chưa phủ | Reviewer, phiên riêng |
| 6. Ngữ cảnh sạch: một khối một owner, sửa thì resume đúng owner | đứt ngữ cảnh, worker lạnh (EB C2: 7 lượt worker vẫn thua) | Orca + controller |

---

## 1. Nguyên tắc

0. **Hai tầng quyết định.** *Cái gì* (chọn Goal, thứ tự, outcome, acceptance, loại trừ, appetite) thuộc PM + anh. *Thế nào* (Solo hay Multi-WP, cắt WP, interface, cách làm) thuộc Lead. Lead không tự đổi *cái gì*: gặp hợp đồng sai/thiếu/mâu thuẫn thì đẩy ngược lên PM + anh.
1. **Một kết quả, một owner giữ ngữ cảnh.** Mặc định Solo khi một session đủ hoàn thành Goal. Khi Goal quá lớn cho một session, Lead chia thành các WP có interface rõ, điều phối worker theo thứ tự phụ thuộc và chịu trách nhiệm kết quả cuối đạt Goal. Không tách API/UI/test thành các owner riêng chỉ vì dễ chia.
2. **Nguồn yêu cầu đi cùng sản phẩm.** Snapshot nguyên văn bất biến + hash; mỗi yêu cầu được trích có ID và được map tới acceptance hoặc quyết định loại trừ mà anh đã duyệt. Gate kiểm đủ các ID đã trích; PM/anh/Reviewer phải đối chiếu snapshot để phát hiện ý chưa được trích. Hash không chứng minh đã hiểu đủ nguồn.
3. **Lời agent không phải bằng chứng.** Orca xác nhận attempt đã settle; controller chạy check; Reviewer đọc phần rủi ro; anh quyết kết quả và quyền merge.
4. **Không đổi cam kết ngầm.** Đổi outcome, scope, acceptance, nguồn hoặc appetite thì phải có Goal version mới và anh duyệt lại. Đổi cách làm hoặc WP trong phạm vi cũ thì Lead quyết, ghi ảnh hưởng, và evidence liên quan thành stale.
5. **"Chưa xong" là trạng thái hợp lệ.** Không hạ acceptance để kịp giờ, không ghi pass khi chưa kiểm, không retry khi attempt cũ chưa settle.

## 2. Hợp đồng dữ liệu

**GoalSpec**
- `id`, `version`; `source {path, sha256, capturedAt, origin}`: snapshot nguyên văn ở `.apos/goals/<id>/source.md`, chỉ đọc sau khi duyệt.
- `problem`, `outcome`, `scope[]`, `exclusions[]`, `constraints[]`, `dependencies[]`, `priority`.
- `requirements[] {id, sourceSpan, text, disposition: acceptance|excluded, acceptanceIds?, exclusionReason?}`: mọi ID phải có disposition; loại trừ do anh duyệt.
- `acceptance[] {id, requirementIds[], expected, examples[{input, expected}], boundaries[], prohibited[], checkIds[], ambiguity: resolved{decision}|blocked}`: mục `blocked` không được dispatch.
- `checks[] {id, kind: command|manual, commandOrProcedure, expectedResult, environment, artifactRule}`: lệnh nằm trong tập anh đã duyệt, chạy cô lập; check thủ công ghi người xác nhận.
- `risks[] {risk, decision, costIfWrong, owner}`.
- `appetite {size: S|M|L, maxSpend, maxWallTime, maxAttempts, overrunPolicy}` được anh duyệt và lưu trong hồ sơ controller ngoài worktree của owner. Bản Goal/WP và brief cấp cho owner không chứa các giới hạn này; chúng chỉ nêu scope, acceptance và cách dừng trung thực.
- Không lưu quyền merge trong GoalSpec. `mergeAuthorization {goalId, goalVersion, integrationCommit, targetBranch, scope, once}` là bản ghi riêng, chỉ được tạo sau khi anh xem Verification Report và chọn merge; controller đối chiếu quyền và commit ngay trước merge.

**ExecutionProposal**
- gắn `goalId`, `goalVersion`, `sourceSha256`;
- `mode`, cách làm, vùng code, rủi ro, map acceptance → check, base SHA, nhánh tích hợp, profile runtime/model, kế hoạch review/gate, chi phí dự kiến;
- Multi-WP thêm: vì sao một session không đủ, thứ tự WP, mỗi WP nhận gì từ WP trước, vùng giao nhau, chi phí và cách kiểm tích hợp;
- Lead soạn và tự quyết proposal; anh không duyệt. Trước dispatch, controller đối chiếu `goalId`, `goalVersion`, `sourceSha256` với Goal đã duyệt và xác nhận proposal/WP không đổi outcome, scope, exclusions, acceptance, checks hoặc appetite; không còn yêu cầu mồ côi, check không xác định, ambiguity hay câu hỏi sản phẩm đang mở. Mọi acceptance của Goal phải được phủ bởi check ở WP hoặc bước tích hợp; chỉ dispatch WP `ready`. Với Multi-WP, kiểm có ít nhất hai WP, phụ thuộc không vòng và interface có version. Tổng chi phí dự kiến gồm WP, tích hợp và review phải nằm trong appetite còn lại; không đạt thì chuyển `needs-decision`, không dispatch.
- `mode = multi-wp` thì controller gửi anh một thông báo (lý do tách, số WP, chi phí dự kiến so với appetite) rồi dispatch luôn, không chờ. Appetite đã duyệt vẫn là cầu dao.

**WorkPackageSpec**
- `id/version`, Goal version, source hash, owner, outcome, scope/exclusions;
- `requirementIds`, `goalAcceptanceIds`, dependencies, interface có version, vùng code dự kiến;
- local acceptance và check, base SHA, trách nhiệm tích hợp, câu hỏi mở.
- Chỉ `ready` khi tiền nhiệm đã tích hợp, interface đã chốt và mọi acceptance có check. Sửa WP thì evidence của WP đó và các phần phụ thuộc thành stale.

## 3. Vai và model

| Vai | Làm gì | Model (phép thử đầu) |
| --- | --- | --- |
| PM / anh | PM là chỗ anh debate các Goal sắp tới: đáng làm không, thứ tự, outcome; cùng anh chốt hợp đồng Goal (nguồn, requirement map, acceptance, ca mơ hồ, appetite); nhận câu hỏi hợp đồng Lead đẩy lên. Không quyết cách làm. Anh duyệt Goal, quyết kết quả và merge | — |
| Lead | Nhận Goal đã duyệt, đọc code, tự quyết Solo hay Multi-WP. Solo: làm trọn Goal. Multi-WP: cắt khối, chốt interface, xử lý câu hỏi kỹ thuật, review tích hợp, chịu trách nhiệm head cuối | Codex `gpt-6.1-terra` |
| Worker | một WP trọn vẹn; sửa trên cùng terminal/worktree; không tự tạo tầng điều phối dưới | Codex `gpt-6.1-terra` |
| Reviewer | phiên đọc riêng, không sửa code; đọc nguồn, quyết định, toàn diff, log gate tại commit đã khoá; ưu tiên khác model/hãng với owner nếu khả dụng | model mạnh theo rủi ro |
| Controller | code thường: so ID, dispatch, chạy gate, tính ngân sách, retry cơ học, đánh thức Lead. **Không dùng LLM để chờ** | không có |

Runtime là adapter khai báo `agent`, `model`, `effort`, khả năng resume và telemetry; adapter đối chiếu model thực trong receipt. Claude Code là một runtime cấu hình được, **chưa phải mặc định** cho tới khi qua cùng phép thử chất lượng. Chỉ hạ model ở việc nào đã được đo là an toàn.

## 4. Lõi kỷ luật thực thi (`apos/skills/_core/execute.md`)

Lead (Solo) và Worker nạp file này thật. Brief ghi đường dẫn và hash của file, và test activation xác nhận owner đã đọc đúng bản. Nội dung là các bất biến chất lượng lấy từ `pm-onlyone`; phần bảng kanban, promote và điều phối đã bỏ vì thuộc về APOS:

1. **Đọc trước khi làm.** Đọc Goal/WP, snapshot nguồn, các quyết định; lập kế hoạch kỹ thuật nhỏ trong phạm vi của mình. Gặp luật giao nhau hoặc chỗ đặc tả im lặng có thể đổi hành vi sản phẩm: ghi câu hỏi, các phương án và giá phải trả nếu đoán sai, rồi dừng phần phụ thuộc vào câu hỏi đó.
2. **Làm.** Làm trên worktree riêng tách từ base đã chốt, kiểm nhanh trong lúc làm, commit theo từng phần có nghĩa. Giữ nguyên test và acceptance đã duyệt; thêm test cho các ca biên. Mọi thay đổi test cũ hoặc oracle phải nêu lý do, gắn với quyết định đã duyệt, và đi qua review.
3. **Tự review như người ngoài.** Khoá `reviewedHead`, đọc toàn diff từ base, đối chiếu file đổi với scope/interface, chạy lại mọi acceptance từ đầu, cộng một phép kiểm độc lập với cách vừa code. Ghi lệnh, exit code, artifact, commit, và phần chưa kiểm được.
4. **Sửa.** Fail thì viết finding có cách tái hiện và kết quả mong đợi, sửa, rồi kiểm lại cả acceptance cũ lẫn phần vừa sửa. Cùng lỗi còn sau hai lượt sửa thì chẩn đoán lại giả định hoặc hợp đồng; vượt quyền thì escalate. Chỉ báo `succeeded` khi đã bàn giao thật; `worker_done` không thay cho gate.
5. **Sau tích hợp (Lead).** Kiểm lại Goal, hồi quy và interface trên head tích hợp. Báo cáo theo từng acceptance. Không gọi WP xanh là Goal xanh.
6. **Ngân sách.** Owner không thấy đồng hồ. Khi controller yêu cầu dừng: ghi trạng thái thật (xong gì, chưa gì, test nào còn đỏ). Báo cáo sai sự thật là lỗi nặng hơn chưa xong.

## 5. Controller và gate

- **Dispatch:** ghi intent trước khi dispatch; đối chiếu Orca khi phản hồi mơ hồ; chỉ nhận `worker_done` của active Dispatch đã settle; giữ terminal cho lượt sửa cùng owner; ack idempotent. Solo cũng chạy trên **worktree riêng** (hiện `orca.ts:114-115,154-159` dùng `path:${repoPath}`).
- **Brief:** chỉ trỏ đường dẫn + hash tới skill, source và spec; không chép nguyên văn qua tham số shell (lượt đầu sprint đã hỏng vì ký tự `$`).
- **Sau `succeeded`:** controller chạy gate. Thiếu hoặc fail check thì tạo finding máy sinh gồm acceptance/check ID, SHA và log; chỉ resume đúng owner/worktree khi dispatch trước đã settle và còn attempt, ngân sách. Lỗi chưa xác định được nguyên nhân, cùng lỗi sau hai lượt sửa, hoặc hết giới hạn thì chuyển `needs-decision`.
- **Gate:** khoá `baseCommit` → `deliveryCommit` → `integrationCommit`. Chạy cùng lệnh, môi trường, dữ liệu và cách định danh test trên base/head trong workspace sạch tại đúng SHA; lưu exit code, log, artifact hash, tập fail và `newFailures`. Baseline không chạy được hoặc kết quả flaky là `unverifiable`, không tự coi xanh; fail mới là đỏ. Sau merge, chạy lại gate tại head nhánh đích.
- **Review bắt buộc** khi: Multi-WP, diff chạm giao diện chung, có thay đổi test/oracle, có quyền auto-merge, hoặc rủi ro cao. Controller tự phân loại từ diff và hợp đồng, không chỉ dựa `proposal.risks` (hiện `reviews.ts:20-21`). Review gắn reviewer identity, dispatch/session và commit; controller xác nhận Reviewer khác owner, dùng phiên/ngữ cảnh riêng và đọc nguồn cùng diff tại đúng commit. Tên tự nhập không đủ.
- **Đánh thức Lead (Multi-WP):** gom package settle, câu hỏi hợp đồng và gate tích hợp đỏ; đối chiếu dispatch/terminal rồi resume Lead một lần cho mỗi tập sự kiện đã gom trên đúng terminal. Lead xử lý xong thì kết thúc lượt.
- **Lưu trữ:** event log local bền vững là nguồn sự thật; SQLite là index tái dựng được. Commit `.apos/` vào Git chỉ ở các mốc: Goal duyệt, proposal Lead chốt và controller kiểm đạt, delivery/verification, outcome. Đổi cách lưu phải kèm test migration và crash-recovery (hiện index tái dựng từ event đã commit, `journal.ts:17-30`).

## 6. Nhịp duyệt và ngân sách

Ba cổng của anh, khớp `APOS_PROJECT_OVERVIEW` gate A/B/D (gate C — duyệt Execution Plan — bỏ):
- **A. Duyệt Goal** (cùng PM): nguồn, requirement map, acceptance, appetite, ưu tiên. Có thể duyệt một tập Goal một lần; duyệt Goal không có nghĩa cho chạy.
- **B. Chọn Goal**: Lead đọc backlog, đề xuất Goal tiếp theo kèm lý do; anh chọn / đổi / hoãn. Chỉ Goal được chọn mới được dispatch. Đây là một lần bấm, không phải duyệt kế hoạch.
- **D. Nghiệm thu** (PM + anh): PM đối chiếu Verification Report với Goal đã chốt; anh chọn close / revise / stop và quyết merge trên cùng thẻ.

Ngoài ba cổng: Lead chọn Multi-WP thì anh nhận **thông báo** (không phải duyệt).

Phân loại lỗi theo overview, gắn với người xử lý:
- `intent_gap` (WHAT/acceptance mơ hồ, mâu thuẫn): về PM + anh, Goal version mới;
- `bad_plan` (cách làm/WP contract sai): Lead tự sửa plan, controller kiểm máy lại, evidence liên quan thành stale;
- `patch` (lỗi cục bộ, finding máy sinh từ gate): resume đúng owner;
- `defer` (ngoài scope, nợ kỹ thuật): ghi backlog/decision kèm evidence.

Trạng thái Goal: `built` → `verified` (gate máy đạt) → `accepted` (anh, cổng D) → `closed`.

`maxSpend`, `maxWallTime`, `maxAttempts` là **cầu dao của controller, không phải deadline trong brief**. Chạm trần thì yêu cầu dừng có kiểm soát và checkpoint trung thực; vượt trần chỉ tiếp tục khi anh quyết. Checkpoint của owner theo **sự kiện công việc** (xong một phần kiểm được, gặp điều chưa rõ, trước khi đổi hướng lớn, trước khi bàn giao), không theo phút.

**Telemetry** theo Run/Task/Dispatch và vai: input cache/chưa cache, output, model thực, giá theo provider, wall time, thời gian chờ anh, số lần anh phải quyết. Thiếu số thì ghi `unknown`, không nội suy.

## 7. Thứ tự triển khai

1. Hợp đồng nguồn/requirement/check + bộ chạy gate trên fixture (làm thành một lát dọc), rồi nối gate duyệt Goal và gate base/head trên đúng commit.
2. Lõi `_core/execute.md` cho Lead/Worker; brief trỏ skill path + hash; test activation.
3. Adapter runtime/model/receipt/telemetry; Solo trên worktree riêng; retry cùng owner với finding máy sinh.
4. Event log bền vững, index tái dựng được, commit theo mốc; test migration và crash-recovery.
5. Smoke Solo thật cộng toàn bộ ca tiêm lỗi; sửa tới khi gate an toàn đạt.
6. Pilot Solo ghép cặp với `pm-onlyone`; thêm mẫu khi đủ quota.
7. Thử đánh thức Lead, Multi-WP và kiểm tích hợp trên một Goal quá lớn cho một session, với các WP phụ thuộc tuần tự; đo kết quả, số lần anh can thiệp và chi phí so với appetite. Ba Goal Solo song song là phép đo scheduling riêng.
8. Dashboard, tự xếp backlog, tối ưu model: chỉ làm khi số đo cho thấy cần.

## 8. Phép thử và ngưỡng

**An toàn (bắt buộc trước khi dùng thật).** Tiêm các lỗi sau và kiểm mỗi ca ra trạng thái giải thích được:
- evidence `pass` giả, log/artifact sai, commit cũ;
- review sai người;
- test fail mới, base đỏ;
- dispatch chưa settle, phản hồi CLI bị mất;
- brief có `$` hoặc dấu nháy;
- source bị thay sau khi duyệt, head nhánh đích bị đổi;
- merge không có quyền;
- restart rồi reconcile.

Ngưỡng: **0 false verification, 0 duplicate dispatch, 0 unauthorized merge**.

**Chất lượng Solo (ghép cặp).**
- Cùng seed, nguồn, model code, giới hạn tài nguyên, verifier ẩn; đảo thứ tự trong từng cặp; chấm trên head đã tích hợp, tính cả các lần dừng sớm.
- Ghi reward, f2p/p2p, chi phí thực, token theo vai, wall time, thời gian anh tham gia.
- Pilot 3 cặp theo quota; 10 cặp là mốc đọc dữ liệu đầu tiên, không phải chứng nhận thống kê.

Đích:
- **Solo:** tỉ lệ đạt không kém `pm-onlyone` quá 5 điểm; chi phí, token và thời gian ≤ 1,10×.
- **Multi-WP:** với Goal quá lớn cho một session, ghi Goal có tới `verified` không, số lần anh phải can thiệp và chi phí thực so với appetite đã duyệt. Ghi cả các lần dừng sớm và lý do.

Chưa đủ mẫu thì ghi kết luận "chưa xác nhận"; Solo vẫn là mặc định khi một session đủ cho Goal.

## 9. So với APOS hiện tại: việc cần sửa

| # | Hiện tại | Sửa thành | Mức |
| --- | --- | --- | --- |
| 1 | `verification.ts:16-40` nhận evidence tự khai | controller chạy check trên đúng SHA, so fail base/head | P0 |
| 2 | Goal `{outcome, scope, exclusions, acceptance{id,text}, appetite}` (`contracts.ts:7-15`) | source + hash, requirements map, acceptance có examples/boundaries/checks/ambiguity | P0 |
| 3 | skill vai 6–9 dòng | `_core/execute.md` + brief trỏ path/hash + test activation | P0 |
| 4 | `--agent claude`, không có model (`orca.ts:115,129`) | adapter cấu hình theo vai, thử đầu codex terra, đối chiếu receipt | P1 |
| 5 | Solo `--worktree path:repoPath` | worktree riêng từ base | P1 |
| 6 | `succeeded` mà thiếu evidence thì đứng im | finding máy sinh, resume đúng owner, có giới hạn | P1 |
| 7 | review chỉ bắt buộc theo risks hoặc auto-merge | phân loại rủi ro từ diff/hợp đồng; review gắn dispatch | P1 |
| 8 | metrics không có token | telemetry theo vai/provider | P1 |
| 9 | mỗi event là một commit Git | event log + commit theo mốc + recovery test | P1 |
| 10 | 4 cổng A/B/C/D, anh duyệt proposal | 3 cổng A/B/D; proposal do Lead quyết, controller kiểm máy; Multi-WP thì báo anh | P2 |
| 11 | Lead Multi-WP không được đánh thức | gom sự kiện, resume Lead một lần (sau khi Solo qua thử) | P2 |
| 12 | `appetite` là chuỗi tự do | `{size, maxSpend, maxWallTime, maxAttempts, overrunPolicy}`, chỉ controller đọc | P1 |

## 10. Giới hạn

- Hard12 (n = 1, model và harness lẫn nhau) chỉ là **tín hiệu thiết kế**, không phải bằng chứng nhân quả. Lõi kỷ luật là giả thuyết có cơ chế rõ, cần được đo.
- Chưa có số đo nào cho APOS v2. Mọi con số tiết kiệm đều phải đến từ phép thử ở mục 8.
