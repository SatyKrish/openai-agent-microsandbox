# Copyright 2026 openai-agent-substrate contributors
# SPDX-License-Identifier: Apache-2.0
"""ChatKit's two-phase uploads, staged on the host until a turn copies them into the sandbox."""

from __future__ import annotations

import re
import time
from pathlib import Path

from chatkit.store import AttachmentStore
from chatkit.types import Attachment, AttachmentCreateParams, AttachmentUploadDescriptor, FileAttachment

from .spec import MIB, Uploads

_ATTACHMENT_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
_STAGED_TTL_S = 3600


class UploadRejected(ValueError):
    """An upload the server refuses; the message is safe to show."""


def size_limit(uploads: Uploads) -> str:
    return f"Uploads are limited to {uploads.max_bytes // MIB} MiB per file."


def upload_name(name: str, uploads: Uploads) -> str:
    """A plain file name for inputs/uploads/, keeping one of the accepted extensions."""
    base = Path(name.replace("\\", "/")).name
    stem, dot, extension = base.rpartition(".")
    extension = "." + extension.lower() if dot else ""
    if extension not in uploads.types:
        raise UploadRejected(uploads.hint)
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip(".-")[:80] or "document"
    return stem + extension


class UploadStore(AttachmentStore[dict]):
    def __init__(self, store, directory: Path, base_url: str, uploads: Uploads | None):
        self.store = store
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.base_url = base_url.rstrip("/")
        self.uploads = uploads

    def policy(self) -> Uploads:
        if self.uploads is None:
            raise UploadRejected("This agent does not accept uploads.")
        return self.uploads

    def path(self, attachment_id: str) -> Path:
        if not _ATTACHMENT_ID.fullmatch(attachment_id):
            raise UploadRejected("Unknown upload")
        return self.directory / attachment_id

    def _prune(self) -> None:
        # Files that were uploaded but never sent do not linger.
        cutoff = time.time() - _STAGED_TTL_S
        for staged in self.directory.iterdir():
            if staged.stat().st_mtime < cutoff:
                staged.unlink(missing_ok=True)

    async def create_attachment(self, input: AttachmentCreateParams, context: dict) -> Attachment:
        uploads = self.policy()
        name = upload_name(input.name, uploads)
        if input.size > uploads.max_bytes:
            raise UploadRejected(size_limit(uploads))
        self._prune()
        attachment_id = self.generate_attachment_id(input.mime_type, context)
        descriptor = AttachmentUploadDescriptor(url=f"{self.base_url}/uploads/{attachment_id}", method="PUT")
        return FileAttachment(id=attachment_id, name=name, mime_type=uploads.types[Path(name).suffix],
                              upload_descriptor=descriptor)

    async def write_file(self, attachment_id: str, data: bytes, context: dict) -> Attachment:
        uploads = self.policy()
        target = self.path(attachment_id)
        attachment = await self.store.load_attachment(attachment_id, context)
        if attachment.upload_descriptor is None:
            raise UploadRejected("This upload has already been received.")
        if len(data) > uploads.max_bytes:
            raise UploadRejected(size_limit(uploads))
        signature = uploads.signatures.get(Path(attachment.name).suffix)
        if signature is not None:
            if not data.startswith(signature[0]):
                raise UploadRejected(signature[1])
        else:
            try:
                data.decode("utf-8")
            except UnicodeDecodeError:
                raise UploadRejected("Text uploads must be UTF-8.") from None
        partial = target.with_suffix(".part")
        partial.write_bytes(data)
        partial.replace(target)
        attachment = attachment.model_copy(update={"upload_descriptor": None})
        await self.store.save_attachment(attachment, context)
        return attachment

    def read_file(self, attachment_id: str) -> bytes:
        try:
            return self.path(attachment_id).read_bytes()
        except FileNotFoundError:
            raise UploadRejected("An attachment was not uploaded; remove it and attach the file again.") from None

    async def delete_attachment(self, attachment_id: str, context: dict) -> None:
        self.path(attachment_id).unlink(missing_ok=True)
