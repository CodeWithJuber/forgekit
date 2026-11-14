"""Optional offline Docling worker. No model installation or remote service usage."""
import errno
import io
import json
import os
import sys
from pathlib import Path


def deny_linux_network():
    # libseccomp selects the native architecture and carries the denylist across
    # extension modules, threads and subprocesses (including OCR helpers).
    import ctypes
    c = ctypes
    lib = c.CDLL("libseccomp.so.2")
    lib.seccomp_init.argtypes = [c.c_uint32]
    lib.seccomp_init.restype = c.c_void_p
    lib.seccomp_syscall_resolve_name.argtypes = [c.c_char_p]
    lib.seccomp_rule_add.argtypes = [c.c_void_p, c.c_uint32, c.c_int, c.c_uint]
    lib.seccomp_load.argtypes = [c.c_void_p]
    lib.seccomp_release.argtypes = [c.c_void_p]
    context = lib.seccomp_init(0x7fff0000)  # SCMP_ACT_ALLOW
    if not context:
        raise OSError()
    try:
        for name in (b"socket",b"socketpair",b"socketcall",b"connect",b"sendto",b"sendmsg",b"sendmmsg",
                     b"io_uring_setup",b"io_uring_enter",b"io_uring_register"):
            nr = lib.seccomp_syscall_resolve_name(name)
            if nr >= 0 and lib.seccomp_rule_add(context, 0x00050000 | errno.EPERM, nr, 0) != 0:
                raise OSError()
        if lib.seccomp_load(context) != 0:
            raise OSError()
    finally:
        lib.seccomp_release(context)


def main():
    if sys.platform.startswith("linux"):
        try:
            deny_linux_network()
        except (OSError, AttributeError):
            return {"error":"Docling requires the Linux libseccomp offline guard"}
    elif sys.platform != "darwin" or os.getenv("FORGE_DOCLING_SANDBOXED") != "1":
        return {"error":"Docling needs a supported offline process sandbox (Linux or macOS)"}
    # Set before importing any ML library. Some libraries use a native network stack.
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_DATASETS_OFFLINE="1",
                      HF_HUB_DISABLE_TELEMETRY="1", OMP_NUM_THREADS="1", OPENBLAS_NUM_THREADS="1")
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions, TesseractCliOcrOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling_core.types.io import DocumentStream
    data = sys.stdin.buffer.read(8 * 1024**2 + 1)
    if len(data) > 8 * 1024**2:
        raise ValueError()
    opts = PdfPipelineOptions(artifacts_path=Path(sys.argv[1]), enable_remote_services=False,
                              allow_external_plugins=False, do_ocr=True, do_table_structure=True,
                              ocr_options=TesseractCliOcrOptions(lang=sys.argv[2].split(",")))
    converter = DocumentConverter(allowed_formats=[InputFormat.PDF],
                                  format_options={InputFormat.PDF:PdfFormatOption(pipeline_options=opts)})
    result = converter.convert(DocumentStream(name="source.pdf",stream=io.BytesIO(data)), max_num_pages=200,
                               max_file_size=8 * 1024**2)
    if getattr(result.status, "value", str(result.status)) != "success":
        return {"error":"Docling could not fully convert this PDF"}
    sections = []
    size = 0
    for n in sorted(result.document.pages):
        text = result.document.export_to_markdown(page_no=n)
        if "-----BEGIN " in text.upper():
            raise ValueError()
        size += len(text)
        if size > 2 * 1024**2:
            raise ValueError()
        sections.append([f"page {n}", text])
    return {"sections":sections, "structure":{"pages":len(sections),"converter":"docling","tableAccuracy":"unverified"}}


if __name__ == "__main__":
    try:
        output = main()
    except ModuleNotFoundError:
        output = {"error":"Docling needs a locally installed docling package, OCR engine and prefetched models"}
    except Exception:
        output = {"error":"Offline Docling conversion failed; check local models, OCR languages and PDF limits"}
    print(json.dumps(output, ensure_ascii=False))
