> **ĐÃ LỖI THỜI — đừng thực hiện theo file này.** Upstream v4 đã có "retained Temporary Chat"
> theo một thiết kế khác; cờ mà kế hoạch này mô tả không còn được bất kỳ source nào đọc. Con số
> "trần composer 110.000" bên dưới cũng sai: trần medium/high hiện là 1.048.572. Giữ lại để ghi
> nhớ hướng đã cân nhắc và vì sao không đi tiếp, không phải để làm theo.

# Kế hoạch: bỏ sàn chỉ dẫn khỏi mỗi lượt

## Vấn đề, bằng số đo

Mỗi lượt mở một Temporary Chat mới, nên toàn bộ chỉ dẫn phải gửi lại từ đầu. Sàn đó không nén
được và không bao giờ bị fit recovery bỏ.

| Mốc | Sàn (JSON bytes) | Nguồn |
|---|---|---|
| Trước 22/08 | 77.521 | thông báo compaction stall |
| Sau khi cắt AGENTS.md | 63.018 | thông báo compaction stall |
| Sau bộ lọc `## Memory` | ~53.000 | ước từ 9.389 ký tự/message, đo trên 25 phiên |

Trần composer là 110.000. Nghĩa là ~48% ngân sách mỗi lượt tiêu vào thứ không đổi giữa các lượt.

Đo được: 153/232 lượt chạy trên 95% trần; một phiên 228 message vứt 53 message sau khi đã nén.

## Điều kiện tiên quyết — ĐỪNG bỏ qua

**Chỉ làm khi số liệu chứng minh còn cần.** Sàn vừa giảm ~30%. Trước khi viết dòng nào, đọc
`~/.codex-chatgpt-web/diagnostics/turn-failures.jsonl` sau vài chục lượt dùng thật:

- Không còn `compaction is no longer reducing` → **dừng, không làm kế hoạch này.**
- Còn nhưng plateau tụt rõ → cân nhắc phương án C (nén chỉ dẫn) cho vừa khoảng thiếu.
- Còn nguyên → thi công kế hoạch này.

## Bất biến đang bảo vệ điều gì

`browser-worker.ts` có `assertTemporaryChatPage()` và comment:

> "A Codex turn owns one isolated Temporary Chat document. Reusing the same ChatGPT SPA page can
> retain the previous transcript and autocomplete DOM, so an @app lookup may select stale UI from
> the preceding turn."

Đọc kỹ: lý do là **tái dùng trang SPA**, không phải tái dùng hội thoại. Phân biệt này là bản lề của
kế hoạch — mỗi lượt vẫn mở **trang mới**, chỉ điều hướng tới **URL hội thoại đã có**. Nếu trong lúc
làm phát hiện DOM vẫn cũ dù trang mới, thì bất biến kia rộng hơn comment mô tả và **phải dừng lại**.

## Vì sao không có đường tắt

Cám dỗ: "giữ hội thoại chỉ để chứa chỉ dẫn, vẫn gửi full context mỗi lượt". **Sai.** Dùng lại một
hội thoại thì mọi lượt trước còn nguyên trong đó; gửi full context mỗi lượt sẽ chồng chất chứ không
tiết kiệm. B bắt buộc đi kèm giao thức delta.

## Thiết kế

Công tắc `persistentConversation` trong `config.json`, **mặc định `false`** (giữ nguyên hành vi
hôm nay). Bật lên thì:

```
Lượt 1  → chat thường (không temporary): gửi chỉ dẫn + toàn bộ context. Ghi lại conversationId
          và chữ ký của phần đã gửi.
Lượt N  → trang MỚI, điều hướng tới conversationId đó, chỉ gửi phần chênh lệch kể từ lượt N-1.
```

### Van an toàn: xoay vòng khi lệch

Bridge biết chính xác nó đã gửi gì. Mỗi lượt đối chiếu "thứ ChatGPT đã thấy" với "thứ Codex muốn
nó thấy". Lệch thì **xoay vòng**: mở hội thoại mới, gửi lại toàn bộ — tức lùi về đúng hành vi hôm
nay cho riêng lượt đó.

Lệch xảy ra khi:
- Codex nén/vứt message mà ChatGPT vẫn nhớ (thường gặp nhất)
- Hội thoại chạm trần context của chính nó
- Hội thoại bị xoá phía ChatGPT
- `conversationId` không mở được

**Tính chất quan trọng: xấu nhất bằng đúng hiện tại, không bao giờ tệ hơn.**

## Các bước, kèm cách kiểm chứng

```
1. Thêm cờ config + đường dẫn qua ResolvedBrowserConfig, mặc định false
   → verify: unit test cờ tắt cho hành vi byte-identical với hôm nay

2. Ghi/đọc conversationId theo session, kèm chữ ký phần đã gửi
   → verify: unit test thuần, không đụng browser

3. Tính delta + phát hiện lệch (hàm thuần)
   → verify: unit test — Codex nén giữa chừng PHẢI báo lệch
   → verify: đối chứng — bỏ bộ phát hiện thì test phải RỚT

4. Điều hướng tới hội thoại có sẵn trên TRANG MỚI, nới assertTemporaryChatPage theo cờ
   → verify: lượt sống, soi connector chọn đúng row (đây là chỗ rủi ro nhất)
   → nếu DOM vẫn cũ dù trang mới: DỪNG, bất biến rộng hơn comment

5. Xoay vòng khi lệch
   → verify: ép lệch nhân tạo, xác nhận lùi về gửi full và lượt vẫn thành công

6. Đo: replay-context + turn-failures trước/sau, vài chục lượt thật
   → giữ nếu sàn về gần 0 và không sinh lỗi mới; revert nếu không
```

## Rủi ro đã biết

- **Đường Playwright không có test đơn vị nào.** Bước 4–5 chỉ kiểm chứng được bằng lượt sống, cần
  người ngồi cạnh nhìn. Đừng làm lúc nửa đêm.
- Gỡ `assertTemporaryChatPage` là gỡ hàng rào quanh đường chọn connector — đường đã hỏng hai lần
  ngày 22/08 (va chạm entry, rồi kích hoạt hai lần).
- Hội thoại bền tích luỹ theo thời gian; cần chính sách xoay vòng theo tuổi/kích thước, không chỉ
  theo lệch.

## Quyết định đã chốt

- Người dùng chấp nhận hội thoại nằm trong lịch sử ChatGPT, nên **riêng tư không còn là cái giá**.
- Vì vậy **B thắng C**: B xoá hẳn sàn và không mất mát; C chỉ giảm 30–40% và có mất mát.
- Công tắc là bắt buộc, không phải tuỳ chọn: nó là đường lui và là cách A/B đo được.
