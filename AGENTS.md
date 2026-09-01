# AGENTS.md — codex-chatgpt-web

Cầu nối Codex Responses API → ChatGPT Web UI. Từ v4, một lượt **giữ lại conversation** tới khi Codex
yêu cầu compact, chứ không mở Temporary Chat mới mỗi lượt và gửi lại toàn bộ context như bản cũ. Trần
composer hiện là **1.048.572 ký tự** (`CHATGPT_WEB_MEDIUM_HIGH_COMPOSER_CHAR_LIMIT`, gói Plus, effort
medium/high) — khớp upstream, không còn là con số 110.000 mà các đợt đo cũ dựa vào. Với trần này,
replay các rollout gần đây giữ 100% message, prompt lớn nhất ~182k ký tự: pruning và các hằng số timing
**không còn là nút thắt**. Rủi ro thực tế còn lại là **catalog tĩnh bị drift** — nếu `model_catalog_json`
bị ghi đè về giới hạn cũ, Codex nén sớm và một bài nhiều ảnh có thể chậm gấp ba (đã từng xảy ra). Doctor
kiểm điều này ở check `model-catalog`; hiện nó khớp, không có bằng chứng đang ép nén sai.

## Không đổi hằng số nếu chưa biết vì sao nó tồn tại

Đợt sửa hàng loạt hằng số timing ngày 21/08 gây ra: tab bị hủy giữa lượt sau 120s, heartbeat im lặng,
công thức toán vỡ khi stream, semantic pruning thành no-op (vứt 59/84 message mỗi lượt).

| Hằng số | Là biên chống lỗi gì |
|---|---|
| `stabilityMs = 750` (markdown.ts) | KaTeX viết lại toán sau vài trăm ms; delta là append-only, chốt sớm là vỡ vĩnh viễn |
| `CHATGPT_MENU_ANIMATION_SETTLE_MS = 500` | Chống đọc geometry giữa animation |
| `CHATGPT_DEFAULT_VERBATIM_TOOL_RESULT_MESSAGES = 6` | Đo được: nâng lên 12 làm message giữ được tụt 83 → 9 khi bị ép |
| `CHATGPT_UI_SETTLE_MS = 250` | Biên ổn định DOM |
| `CHATGPT_MAX_SINGLE_TOOL_RESULT_CHARS = 40_000` | NGƯỠNG quyết định có cắt hay không, KHÔNG phải kích thước giữ lại (cắt xong còn ~6.064) |

Đường Playwright **không có test đơn vị nào** — số đo là tiêu chí duy nhất. Đo trước, đo sau, revert
nếu không mua được gì.

## Đo đạc

- `scripts/replay-context.ts` — chạy rollout thật qua `compileChatGptWebPrompt` thật.
  Đặt `BUN_TEST=1` để không ghi bẩn diagnostics. Mặc định 60k token thường chỉ phủ vài % phiên;
  dùng `--budget-tokens 400000` mới thấy áp lực thật (script tự cảnh báo `WINDOW CUT`).
- `scripts/measure-turn-latency.ts` — gộp `capturedAt` trong `diagnostics/browser-turns/`.
- Ánh xạ rollout → `CodexMessage` phải khớp `src/responses/parser.ts`: `custom_tool_call` mang payload
  ở `input`, KHÔNG phải `arguments`.
- Build cần **Bun đúng phiên bản** ghi trong `scripts/build-runtime-bundle.ts`; bun ở
  `~/.codex-chatgpt-web/versions/*/runtime/` có thể lệch.

## Deploy

Vào **cả hai** runtime, backup timestamp trước khi ghi đè, `cmp` xác nhận byte-identical:
`~/.codex-chatgpt-web/versions/<ver>/app/` và
`%LOCALAPPDATA%/Programs/codex-web-gpt-launcher/resources/runtime/app/`.
Tiến trình đang chạy giữ bytes cũ tới khi restart launcher.

## Không làm

- Nới postcondition so khớp byte của prompt attachment (`promptTextEquivalent`) — chỉ được siết.
- Tab pooling / pre-warm tab — đã chứng minh hỏng: `bootstrapReady` không về `true`, reaper giết tab.
- Nâng `CHATGPT_WEB_MEDIUM_HIGH_AUTO_COMPACT_TOKEN_LIMIT` — ràng buộc thật là trần ký tự.

## Trước khi báo xong

`bunx tsc --noEmit` → `bun test tests/*.test.ts` → `bun run launcher:test` → `bun run build` → `bun run smoke`
