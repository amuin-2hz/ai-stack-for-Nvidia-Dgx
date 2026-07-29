"""Image-only compatibility module for ARM64 builds without decord wheels."""

class VideoReader:
    def __init__(self, *_args, **_kwargs):
        raise RuntimeError("Video input is unavailable in the ARM64 image-only LocateAnything runtime.")
