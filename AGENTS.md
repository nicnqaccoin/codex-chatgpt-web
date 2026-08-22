# AGENTS.md — codex-chatgpt-web

Cầu nối Codex Responses API → ChatGPT Web UI qua Playwright/Electron. Mỗi lượt mở một
Temporary Chat mới, nên **toàn bộ context được nén và gửi lại từ đầu mỗi lượt**. Đó là lý do
mọi thứ trong repo này xoay quanh một ràng buộc: trần **110.000 ký tự** của composer
(`CHATGPT_WEB_MEDIUM_HIGH_COMPOSER_CHAR_LIMIT`, gói Plus, effort medium/high).

## Luật số 1 — Không đổi hằng số nếu chưa đo được nó mua gì

Đợt "tối ưu" 21/08 sửa một loạt hằng số trong đường Playwright mà không hỏi vì sao chúng tồn tại.
Hậu quả đo được: tab bị hủy giữa lượt sau 120s, heartbeat SSE im lặng, công thức toán bị stream
vỡ thành `F` / `x` hai dòng, semantic pruning thành no-op khiến 59/84 message bị vứt mỗi lượt.

Mỗi hằng số dưới đây là **một biên chống lỗi cụ thể**, không phải độ trễ thừa:

| Hằng số | Vì sao tồn tại |
|---|---|
| `stabilityMs = 750` (`markdown.ts`) | ChatGPT render toán thô rồi KaTeX viết lại sau vài trăm ms. Delta Responses là append-only, chốt sớm là vỡ vĩnh viễn. |
| `CHATGPT_MENU_ANIMATION_SETTLE_MS = 500` | Chống đọc geometry giữa animation menu. |
| `CHATGPT_DEFAULT_VERBATIM_TOOL_RESULT_MESSAGES = 6` | Đã đo: nâng lên 12 làm số message giữ được tụt từ 83 xuống 9 khi context bị ép. |
| `CHATGPT_UI_SETTLE_MS = 250` | Biên ổn định DOM trước khi thao tác. |

Muốn đổi thì đo trước, đo sau, giữ số. Không có test đơn vị nào phủ đường Playwright —
**số đo là tiêu chí duy nhất.**

## Luật số 2 — Đọc TOÀN BỘ lịch sử diagnostics, không đọc cửa sổ gần nhất

Ba lần liên tiếp trong một phiên đã kết luận sai vì lấy mẫu ở cuối file:
- Elide tham số tool "trông trung tính" trên dữ liệu áp lực thấp — thực tế +7 message khi bị ép.
- Verbatim 6→12 "trông miễn phí" trên median — thực tế 83→9.
- Quyết định revert checkpoint từ 7 bản ghi trong khi có 67 (9% so với thực tế median 29,2%, đỉnh 96,5%).

Diagnostics ở `~/.codex-chatgpt-web/diagnostics/`. Đọc hết rồi hãy kết luận.

## Luật số 3 — `grep` mọi cổng chặn trước khi ship

Một lượt chạy thật của người dùng đã bị giết sau 8 phút 39 giây vì còn sót cổng thứ ba:
`if (turn.captureLunaCheckpoint && turn.modelId !== CHATGPT_WEB_LUNA_MODEL_ID) throw ...`.
Hai cổng đầu đã bỏ, cổng thứ ba thì không. Lệnh lẽ ra phải chạy trước khi ship:
`rg -n CHATGPT_WEB_LUNA_MODEL_ID src/`.

Quy tắc chung: sửa một hành vi thì tìm **hết** mọi nơi hiện thực hành vi đó, đừng dừng ở chỗ đầu tiên.

## Đo đạc

- `scripts/replay-context.ts` — chạy rollout thật (`~/.codex/sessions/**/rollout-*.jsonl`) qua
  `compileChatGptWebPrompt` thật. Đặt `BUN_TEST=1` để `appendDiagnosticRecord` không ghi bẩn
  vào diagnostics thật.
- `scripts/measure-turn-latency.ts` — gộp `capturedAt` trong `diagnostics/browser-turns/` thành
  bảng median/max.
- So sánh hai bản: `git worktree add` + junction `node_modules`, chạy cùng script trên cùng file rollout.

**Ánh xạ rollout → `CodexMessage` phải khớp `src/responses/parser.ts`.** Cụ thể: `custom_tool_call`
mang payload ở trường `input`, KHÔNG phải `arguments`. Đọc nhầm trường này từng làm apply_patch
bị đo thành "2 ký tự" và dẫn tới một kết luận sai hoàn toàn.

## Deploy

Deploy vào **cả hai** thư mục runtime, backup kèm timestamp trước khi ghi đè, `cmp` xác nhận
byte-identical:
- `~/.codex-chatgpt-web/versions/2.1.11-win32-x64/app/`
- `%LOCALAPPDATA%/Programs/codex-web-gpt-launcher/resources/runtime/app/`

Sau khi restart launcher, xác nhận bridge chạy đúng bytes (`cmp` `dist/runtime/app/cli.js` với
runtime đang chạy).

## Không làm

- **Nới lỏng postcondition so khớp byte của prompt attachment.** Tối ưu ở đó chỉ được giảm chi phí.
- **Tab pooling / pre-warm tab.** Đã chứng minh hỏng: `bootstrapReady` không bao giờ về `true`,
  reaper giết tab sau 120s giữa lượt.
- **Nâng `CHATGPT_WEB_MEDIUM_HIGH_AUTO_COMPACT_TOKEN_LIMIT`.** Ràng buộc thật là trần ký tự,
  không phải token; nâng chỉ khiến nhiều message tới hơn rồi bị fit recovery vứt.

## Trước khi báo xong

`bunx tsc --noEmit` → `bun test tests/*.test.ts` → `bun run launcher:test` → `bun run build` → `bun run smoke`
