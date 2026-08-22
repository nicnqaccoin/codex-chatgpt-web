# Nhiệm vụ

Giảm thời gian setup mỗi lượt trong `src/adapters/chatgpt-web/browser-worker.ts`.

## Bối cảnh đo được

Mỗi lượt mất khoảng 9,4 giây trước khi ChatGPT bắt đầu nghĩ. Hai mục lớn nhất:

- **nhập prompt: 2,48s** (đỉnh 6,58s)
- **gắn connector: 1,31s + 0,81s**

Số này lấy từ `~/.codex-chatgpt-web/diagnostics/browser-turns/*/NN-<checkpoint>.json`.
`scripts/measure-turn-latency.ts` gộp chúng thành bảng median/max.

## Phạm vi

Chỉ `src/adapters/chatgpt-web/browser-worker.ts`. Không đụng file khác trừ khi bắt buộc,
và nếu bắt buộc thì nói rõ vì sao.

## Yêu cầu

1. Giảm chi phí thật của hai đường trên.
2. **Postcondition so khớp byte của prompt attachment phải giữ nguyên độ chặt.** Prompt gắn vào
   composer phải được xác minh khớp từng byte với prompt dự định. Không đổi sang so sánh độ dài,
   so sánh prefix, hay bỏ kiểm tra.
3. Giải thích mỗi thay đổi mua được gì, và vì sao nó an toàn.

## Cách tự kiểm

```
bunx tsc --noEmit
bun test tests/*.test.ts     # phải giữ nguyên 433 pass / 0 fail
```

Đường Playwright **không có test đơn vị nào**. Nghĩa là test xanh KHÔNG chứng minh thay đổi của
bạn đúng — nó chỉ chứng minh bạn chưa làm hỏng thứ khác. Hãy tự nói rõ bạn dựa vào đâu để tin
thay đổi của mình đúng.

Đọc `AGENTS.md` ở gốc repo trước khi bắt đầu.
