# HR Tools

Webapp nội bộ xử lý dữ liệu Excel **trực tiếp trên trình duyệt**. Admin cấu hình các flow xử lý (đối chiếu, gộp file, tổng hợp báo cáo…) bằng giao diện, không cần code; User chọn flow, chọn file, chạy và tải kết quả về.

> **Dữ liệu nhân sự không rời máy người dùng.** File Excel được đọc và xử lý trong Web Worker của trình duyệt; server chỉ lưu tài khoản, cấu hình flow và log metadata.

## Trạng thái

Ứng dụng đang được **viết lại từ đầu theo tài liệu** (quyết định 2026-11-13, ADR-012). Repo hiện chưa có code ứng dụng: chỉ có tài liệu, dữ liệu nghiệm thu và hệ thống chỉ dẫn cho Claude. Bản đang chạy production vẫn nằm ở repo cũ cho tới khi bản mới hoàn thành.

Kế hoạch, việc đang làm và các quyết định còn chờ: [`docs/redesign/06-plan.md`](docs/redesign/06-plan.md).

## Cấu trúc thư mục

```
docs/
  redesign/     Tài liệu thiết kế 00–08 + ADR (tiếng Anh); 06-plan.md = kế hoạch và trạng thái
  MEMORY.md     Nhật ký quyết định (YYYY-MM-DD HH:MM - Quyết định)
  archive/      Tài liệu cũ đã đóng băng: spec.md, kế hoạch cũ, README cũ, bộ text tiếng Việt
fixtures/       Dữ liệu GIẢ dùng nghiệm thu engine (flow lương – chấm công, 182 ca công thức)
vendor/         Thư viện vendored (SheetJS CE), có checksum
CLAUDE.md       Hướng dẫn làm việc cho Claude (file duy nhất luôn được nạp)
.claude/        rules (theo vùng code) · skills (quy trình) · agents · hooks
```

Hướng dẫn cài đặt, Supabase, sao lưu và khôi phục của bản cũ: [`docs/archive/README-legacy.md`](docs/archive/README-legacy.md). Các mục này sẽ được viết lại ở đây khi phần tương ứng của bản mới hoàn thành.

## Nguyên tắc bắt buộc

- Không gửi nội dung file Excel / dữ liệu nhân sự lên server, không log ra console.
- Mọi bảng Supabase bật RLS; client không dùng service role key.
- Tham số người dùng chỉ được bind dưới dạng giá trị, không nối chuỗi vào SQL/code.
- Tiền tệ và ngày công tính bằng decimal, không dùng float.
- Dữ liệu test luôn là dữ liệu giả.
- Mọi quyết định đã chốt ghi vào `docs/MEMORY.md`.
