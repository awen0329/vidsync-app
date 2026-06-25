// braw-thumb: decode frames from a Blackmagic RAW (.braw) clip to PPM images,
// for use as thumbnails and short preview clips. Built against the Blackmagic
// RAW SDK; the runtime libraries are loaded from next to this executable
// (Windows: the SDK DLLs; macOS: BlackmagicRawAPI.framework).
//
// Two modes:
//
//   Thumbnail (single frame):
//     braw-thumb <input.braw> <output.ppm>
//
//   Preview clip (a sampled sequence):
//     braw-thumb --clip <input.braw> <framesDir> <fps> <seconds>
//       Writes <framesDir>/f_00001.ppm, f_00002.ppm, … — every (srcFps/fps)-th
//       source frame, up to fps*seconds frames. The host assembles them into
//       an MP4 with ffmpeg.
//
// Exit: 0 on success (at least one frame written), non-zero otherwise.
//
// Everything decodes at 1/8 resolution (blackmagicRawResolutionScaleEighth) so
// a 4.6K clip becomes ~484x272 — fast and low-memory, which matters because
// this runs as a throwaway subprocess.

#ifdef _WIN32
    #include <windows.h>
    #include "BlackmagicRawAPIDispatch.h"
    #define PATH_SEP "\\"
#else
    #include <CoreServices/CoreServices.h>
    #include "BlackmagicRawAPI.h"
    #define PATH_SEP "/"
    // The Mac SDK's headers don't define a fopen_s; map to standard fopen.
    static inline int fopen_s(FILE** f, const char* path, const char* mode) {
        *f = fopen(path, mode);
        return (*f == nullptr) ? 1 : 0;
    }
#endif

#include <cstdio>
#include <cstring>
#include <cstdint>
#include <string>
#include <atomic>

namespace {

const BlackmagicRawResourceFormat   kFormat = blackmagicRawResourceFormatRGBAU8;
const BlackmagicRawResolutionScale  kScale  = blackmagicRawResolutionScaleEighth;

std::string        g_singleOut;   // thumbnail mode: the one output path
std::string        g_framesDir;   // clip mode: dir for f_NNNNN.ppm
bool               g_clipMode = false;
std::atomic<int>   g_written{0};

// Map a job's user-data tag to its output path. Tag 0 => thumbnail mode's
// single path; tag N>0 => framesDir\f_<N>.ppm in clip mode.
std::string OutputPathFor(uintptr_t tag)
{
    if (!g_clipMode || tag == 0)
        return g_singleOut;
    char name[32];
    snprintf(name, sizeof(name), "f_%05llu.ppm", (unsigned long long)tag);
    return g_framesDir + PATH_SEP + name;
}

// Write RGBA8 image data as a binary PPM (P6): a 1-line ASCII header then
// width*height RGB triplets, top row first. No padding, no alpha — the
// simplest format ffmpeg reads unambiguously.
void WritePPM(const std::string& path, unsigned int width, unsigned int height, const void* imageData)
{
    FILE* f = nullptr;
    if (fopen_s(&f, path.c_str(), "wb") != 0 || f == nullptr)
        return;

    char header[64];
    int hlen = snprintf(header, sizeof(header), "P6\n%u %u\n255\n", width, height);
    if (hlen <= 0 || fwrite(header, 1, (size_t)hlen, f) != (size_t)hlen)
    {
        fclose(f);
        return;
    }

    const unsigned char* rgba = static_cast<const unsigned char*>(imageData);
    const size_t pixels = (size_t)width * height;
    bool wroteAll = true;
    for (size_t i = 0; i < pixels; ++i)
    {
        if (fwrite(rgba + i * 4, 1, 3, f) != 3) { wroteAll = false; break; }
    }
    fclose(f);
    if (wroteAll)
        g_written.fetch_add(1);
}

class FrameCallback : public IBlackmagicRawCallback
{
public:
    virtual void STDMETHODCALLTYPE ReadComplete(IBlackmagicRawJob* readJob, HRESULT result, IBlackmagicRawFrame* frame) override
    {
        IBlackmagicRawJob* decodeJob = nullptr;

        if (result == S_OK && frame != nullptr)
        {
            frame->SetResolutionScale(kScale);     // best-effort
            result = frame->SetResourceFormat(kFormat);
        }
        if (result == S_OK)
            result = frame->CreateJobDecodeAndProcessFrame(nullptr, nullptr, &decodeJob);
        if (result == S_OK)
        {
            // Carry the output tag from the read job to the decode job so
            // ProcessComplete knows which file to write.
            void* tag = nullptr;
            readJob->GetUserData(&tag);
            decodeJob->SetUserData(tag);
            result = decodeJob->Submit();
        }

        if (result != S_OK && decodeJob != nullptr)
            decodeJob->Release();

        readJob->Release();
    }

    virtual void STDMETHODCALLTYPE ProcessComplete(IBlackmagicRawJob* job, HRESULT result, IBlackmagicRawProcessedImage* image) override
    {
        unsigned int width = 0, height = 0;
        void* data = nullptr;
        void* tag = nullptr;
        job->GetUserData(&tag);

        if (result == S_OK) result = image->GetWidth(&width);
        if (result == S_OK) result = image->GetHeight(&height);
        if (result == S_OK) result = image->GetResource(&data);
        if (result == S_OK && data != nullptr && width > 0 && height > 0)
            WritePPM(OutputPathFor((uintptr_t)tag), width, height, data);

        job->Release();
    }

    virtual void STDMETHODCALLTYPE DecodeComplete(IBlackmagicRawJob*, HRESULT) override {}
    virtual void STDMETHODCALLTYPE TrimProgress(IBlackmagicRawJob*, float) override {}
    virtual void STDMETHODCALLTYPE TrimComplete(IBlackmagicRawJob*, HRESULT) override {}
#ifdef _WIN32
    virtual void STDMETHODCALLTYPE SidecarMetadataParseWarning(IBlackmagicRawClip*, BSTR, uint32_t, BSTR) override {}
    virtual void STDMETHODCALLTYPE SidecarMetadataParseError(IBlackmagicRawClip*, BSTR, uint32_t, BSTR) override {}
#else
    virtual void SidecarMetadataParseWarning(IBlackmagicRawClip*, CFStringRef, uint32_t, CFStringRef) override {}
    virtual void SidecarMetadataParseError(IBlackmagicRawClip*, CFStringRef, uint32_t, CFStringRef) override {}
#endif
    virtual void STDMETHODCALLTYPE PreparePipelineComplete(void*, HRESULT) override {}

    virtual HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, LPVOID*) override { return E_NOTIMPL; }
    virtual ULONG   STDMETHODCALLTYPE AddRef(void) override { return 1; }
    virtual ULONG   STDMETHODCALLTYPE Release(void) override { return 1; }
};

// Cross-platform UTF-8 -> SDK string. On Windows the SDK takes a BSTR
// (UTF-16, length-prefixed) created with SysAllocStringLen; on macOS it
// takes a CFStringRef created from a UTF-8 C string. Caller releases the
// returned handle with FreeSdkString.
#ifdef _WIN32
typedef BSTR SdkString;
SdkString ToSdkString(const char* s)
{
    int len = (int)strlen(s);
    int wlen = MultiByteToWideChar(CP_UTF8, 0, s, len, nullptr, 0);
    BSTR b = SysAllocStringLen(nullptr, wlen);
    if (b != nullptr)
        MultiByteToWideChar(CP_UTF8, 0, s, len, b, wlen);
    return b;
}
void FreeSdkString(SdkString s) { SysFreeString(s); }
#else
typedef CFStringRef SdkString;
SdkString ToSdkString(const char* s)
{
    return CFStringCreateWithCString(nullptr, s, kCFStringEncodingUTF8);
}
void FreeSdkString(SdkString s) { if (s) CFRelease(s); }
#endif

// Submit the read jobs for the requested frames. In clip mode we sample every
// (srcFps/fps)-th frame up to fps*seconds frames; in single mode just frame 0.
void SubmitJobs(IBlackmagicRawClip* clip, int fps, int seconds)
{
    if (!g_clipMode)
    {
        IBlackmagicRawJob* job = nullptr;
        if (clip->CreateJobReadFrame(0, &job) == S_OK && job != nullptr)
        {
            job->SetUserData((void*)(uintptr_t)0);
            if (job->Submit() != S_OK)
                job->Release();
        }
        return;
    }

    uint64_t frameCount = 0;
    clip->GetFrameCount(&frameCount);
    float srcFps = 0.0f;
    clip->GetFrameRate(&srcFps);

    int step = 1;
    if (srcFps > 0.0f && fps > 0)
        step = (int)(srcFps / (float)fps + 0.5f);
    if (step < 1)
        step = 1;

    int maxOut = fps * seconds;
    if (maxOut < 1)
        maxOut = 1;

    uint64_t outIndex = 1;
    for (int i = 0; i < maxOut; ++i)
    {
        uint64_t frameIndex = (uint64_t)i * (uint64_t)step;
        if (frameCount > 0 && frameIndex >= frameCount)
            break;
        IBlackmagicRawJob* job = nullptr;
        if (clip->CreateJobReadFrame(frameIndex, &job) != S_OK || job == nullptr)
            continue;
        job->SetUserData((void*)(uintptr_t)outIndex);
        if (job->Submit() != S_OK)
        {
            job->Release();
            continue;
        }
        ++outIndex;
    }
}

} // namespace

int main(int argc, char* argv[])
{
    const char* input = nullptr;
    int fps = 0, seconds = 0;

    if (argc == 6 && strcmp(argv[1], "--clip") == 0)
    {
        g_clipMode  = true;
        input       = argv[2];
        g_framesDir = argv[3];
        fps         = atoi(argv[4]);
        seconds     = atoi(argv[5]);
    }
    else if (argc == 3)
    {
        input       = argv[1];
        g_singleOut = argv[2];
    }
    else
    {
        fprintf(stderr, "usage: %s <input.braw> <output.ppm>\n"
                        "       %s --clip <input.braw> <framesDir> <fps> <seconds>\n",
                argv[0], argv[0]);
        return 2;
    }

#ifdef _WIN32
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr))
    {
        fprintf(stderr, "CoInitializeEx failed\n");
        return 3;
    }
#endif

    IBlackmagicRawFactory* factory = nullptr;
    IBlackmagicRaw*        codec   = nullptr;
    IBlackmagicRawClip*    clip    = nullptr;
    FrameCallback          callback;
    int rc = 1;

    do
    {
        // NULL = look for the SDK library next to this executable
        // (Windows: BlackmagicRawAPI.dll; macOS: BlackmagicRawAPI.framework).
        factory = CreateBlackmagicRawFactoryInstanceFromExeRelativePath(nullptr);
        if (factory == nullptr) { fprintf(stderr, "no factory (SDK runtime not found next to exe?)\n"); break; }

        if (factory->CreateCodec(&codec) != S_OK || codec == nullptr) { fprintf(stderr, "CreateCodec failed\n"); break; }

        SdkString clipName = ToSdkString(input);
        HRESULT openHr = codec->OpenClip(clipName, &clip);
        FreeSdkString(clipName);
        if (openHr != S_OK || clip == nullptr) { fprintf(stderr, "OpenClip failed\n"); break; }

        if (codec->SetCallback(&callback) != S_OK) { fprintf(stderr, "SetCallback failed\n"); break; }

        SubmitJobs(clip, fps, seconds);
        codec->FlushJobs();   // blocks until all read+decode callbacks finish

        rc = (g_written.load() > 0) ? 0 : 1;
    } while (false);

    if (clip)    clip->Release();
    if (codec)   codec->Release();
    if (factory) factory->Release();
#ifdef _WIN32
    CoUninitialize();
#endif

    return rc;
}
