# Nhiệm vụ: bảng điều khiển chẩn đoán của chính bridge

Dựng **một file HTML tự chứa** hiển thị hành vi thật của bridge, đọc từ dữ liệu chẩn đoán đã tích
trên máy này. Ghi ra `.codex/visualizations/bridge-diagnostics.html`.

Đây không phải bài tập vẽ biểu đồ. Đây là công cụ để trả lời một câu hỏi cụ thể:
**bridge đang chạy sát trần composer đến mức nào, và mất thời gian ở đâu.**

## Nguồn dữ liệu (tất cả đều CHỈ ĐỌC — không sửa, không xoá, không di chuyển)

Gốc: `%USERPROFILE%\.codex-chatgpt-web\diagnostics\`

| File | Bản ghi | Trường |
|---|---|---|
| `context-trim.jsonl` | 232 | `at, mode, initialMessages, keptMessages, omittedMessages, elidedToolResults, promptChars, promptJsonBytes, composerCharLimit, roleCounts{developer,user,assistant,toolResult}, toolResults, toolResultChars, largestToolResultChars, prunedChars, toolNames` |
| `browser-turns/<traceId>/NN-<checkpoint>.json` | 10 lượt × ~14 mốc | mỗi file có `capturedAt`; tên file mang số thứ tự và tên mốc |
| `turn-failures.jsonl` | 14 | có `traceId` |
| `checkpoint.jsonl` | 11 | `at, traceId, omitted, carried, collapsing, applied, reason` |
| `artifact-detection.jsonl` | 8 | `at, messageCount, latestUserIndex, ...` |

Số bản ghi ở trên là số tại thời điểm viết đề. Nếu bạn đếm ra khác thì **dùng số bạn đếm được** và
hiển thị nó — đừng sửa cho khớp bảng này.

## Nội dung bắt buộc

**1. Áp lực context theo thời gian** — quan trọng nhất.
Chuỗi thời gian `promptChars` của cả 232 bản ghi, với `composerCharLimit` là đường trần tham chiếu.
Đánh dấu rõ mọi bản ghi đạt từ 95% trần trở lên. Hiển thị giá trị lớn nhất và phần trăm của nó.

**2. Số phận của message.**
`initialMessages` so với `keptMessages` và `omittedMessages` theo từng lượt. Phải nhìn ra được
lượt nào mất nhiều lịch sử nhất và mất bao nhiêu phần trăm.

**3. Thác thời gian dựng lượt.**
Với mỗi thư mục trong `browser-turns/`, tính khoảng cách giữa các `capturedAt` liên tiếp để ra thời
lượng từng chặng. Rồi tổng hợp **p50 và p95 cho từng tên mốc trên toàn bộ các lượt**. Chuẩn hoá tên
mốc bằng cách bỏ tiền tố số, để các lượt có số chặng khác nhau vẫn gộp được.

**4. Dòng thời gian sự cố.**
14 sự cố, nhóm theo thông báo lỗi. Nếu `traceId` khớp một thư mục trong `browser-turns/` thì nối
hai thứ đó lại với nhau.

**5. Quyết định checkpoint.**
11 bản ghi, tách rõ nhóm `collapsing: true` với nhóm còn lại, và trong mỗi nhóm thì `applied` ra sao.

## Ràng buộc

- **Một file HTML duy nhất, chạy được khi không có mạng.** Không CDN, không `<script src="http...">`,
  không webfont từ xa. Mở bằng `file://` phải hoạt động đầy đủ.
- **Đọc toàn bộ bản ghi, không lấy mẫu ở cuối file.** Hiển thị số bản ghi đã đọc của từng nguồn ngay
  trên giao diện để người xem tự đối chiếu được bằng `wc -l`.
- **Không bịa dữ liệu.** Trường thiếu thì hiển thị là thiếu; không nội suy, không lấy giá trị 0 thay
  cho "không có". Nếu một lượt thiếu mốc nào thì nói rõ là thiếu.
- **Không đọc màu để hiểu.** Mọi thông tin phân biệt bằng màu phải có thêm nhãn, hình dạng hoặc số.
- Tương tác: rê chuột ra giá trị chính xác; chọn một lượt thì các panel liên quan lọc theo lượt đó.

## Cách tự kiểm

```
bunx tsc --noEmit
bun test tests/*.test.ts      # phải giữ 436 pass / 0 fail
```

Rồi tự kiểm chính bản HTML:

1. Mở file, xác nhận **không có lỗi console** và **không có request mạng nào**.
2. Số bản ghi hiển thị trên giao diện phải khớp `wc -l` của từng file nguồn.
3. `promptChars` lớn nhất trên biểu đồ phải khớp giá trị lớn nhất thật sự trong `context-trim.jsonl`.

Nói rõ bạn đã kiểm ba điều đó bằng cách nào. Nếu chưa kiểm được điều nào thì nói là chưa, đừng bỏ qua.

Đọc `AGENTS.md` ở gốc repo trước khi bắt đầu.
