// Zvuk hry přímo z Windows (WASAPI loopback, stejně jako OBS) - náhradní
// cesta, když loopback v Chromiu nejde otevřít. Typicky virtuální zařízení
// ovladačů headsetů (Logitech G HUB, Razer Synapse - prostorový zvuk 7.1),
// Oculus / Meta Quest, Steam Streaming: Chromium se je pokusí otevřít ve
// formátu stereo a Windows to odmítne ("Could not start audio source").
// Tady se výchozí výstup otevře v jeho vlastním formátu (mix format - ten
// jde vždycky), zvuk se převede na stereo float32 a pošle binárně na stdout.
//
// Překládá ho PowerShell (Add-Type) při spuštění - proto jen C# 5 (Windows
// PowerShell 5.1 překládá kompilátorem z .NET Frameworku): žádné $"",
// ?. ani => u členů. Test: tests/loopback.test.mjs (mcs -langversion:5).
//
// Protokol (stdout, little endian):
//   "KLB1"                                 hned po startu (appka podle toho pozná začátek)
//   'F' u32 délka, u32 vzorkovací frekvence, u16 kanálů zdroje, u16 0,
//       u32 maska kanálů, UTF-8 id zařízení         formát (i po znovuotevření zařízení)
//   'A' u32 délka, float32 L,R,L,R...                zvuk (stereo, prokládaně)
//   'E' u32 délka, UTF-8 text                         chyba (pak konec)
// Konec: appka zavře stdin (nebo skončí) -> pomocník skončí.

using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace KineLoopback
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumeratorCom
    {
    }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
        [PreserveSig] int OpenPropertyStore(int access, out IntPtr properties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out int state);
    }

    [Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr audioSessionGuid);
        [PreserveSig] int GetBufferSize(out uint bufferSize);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);
        [PreserveSig] int GetMixFormat(out IntPtr deviceFormat);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr eventHandle);
        [PreserveSig] int GetService(ref Guid interfaceId, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint numFramesToRead, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint numFramesRead);
        [PreserveSig] int GetNextPacketSize(out uint numFramesInNextPacket);
    }

    /// <summary>Formát zvuku zařízení (WAVEFORMATEX / WAVEFORMATEXTENSIBLE).</summary>
    public class WaveFormat
    {
        public int SampleRate;
        public int Channels;
        public int BitsPerSample;
        public int BlockAlign;
        public bool IsFloat;
        /// <summary>Maska reproduktorů (SPEAKER_FRONT_LEFT = 1...); 0 = neuvedená.</summary>
        public uint ChannelMask;

        static readonly Guid SubtypePcm = new Guid("00000001-0000-0010-8000-00aa00389b71");
        static readonly Guid SubtypeFloat = new Guid("00000003-0000-0010-8000-00aa00389b71");

        /// <summary>Formát z bajtů WAVEFORMATEX(TENSIBLE) - zvlášť kvůli testu bez Windows.</summary>
        public static WaveFormat Parse(byte[] raw)
        {
            WaveFormat f = new WaveFormat();
            int tag = BitConverter.ToUInt16(raw, 0);
            f.Channels = BitConverter.ToUInt16(raw, 2);
            f.SampleRate = (int)BitConverter.ToUInt32(raw, 4);
            f.BlockAlign = BitConverter.ToUInt16(raw, 12);
            f.BitsPerSample = BitConverter.ToUInt16(raw, 14);
            f.IsFloat = tag == 3;
            if (tag == 0xFFFE && raw.Length >= 40)
            {
                f.ChannelMask = BitConverter.ToUInt32(raw, 20);
                byte[] g = new byte[16];
                Array.Copy(raw, 24, g, 0, 16);
                Guid sub = new Guid(g);
                if (sub == SubtypeFloat) f.IsFloat = true;
                else if (sub != SubtypePcm) throw new NotSupportedException("format " + sub);
            }
            else if (tag != 1 && tag != 3)
            {
                throw new NotSupportedException("format tag " + tag);
            }
            if (f.Channels < 1 || f.Channels > 32 || f.SampleRate < 8000 || f.SampleRate > 768000) throw new NotSupportedException("channels " + f.Channels + " rate " + f.SampleRate);
            if (f.IsFloat ? f.BitsPerSample != 32 : (f.BitsPerSample != 16 && f.BitsPerSample != 24 && f.BitsPerSample != 32)) throw new NotSupportedException("bits " + f.BitsPerSample);
            if (f.BlockAlign != f.Channels * f.BitsPerSample / 8) throw new NotSupportedException("block align " + f.BlockAlign);
            return f;
        }

        public static WaveFormat FromPointer(IntPtr p)
        {
            int cbSize = Marshal.ReadInt16(p, 16) & 0xFFFF;
            int tag = Marshal.ReadInt16(p, 0) & 0xFFFF;
            int size = 18 + (tag == 0xFFFE ? Math.Min(cbSize, 22) : 0);
            byte[] raw = new byte[Math.Max(size, 18)];
            Marshal.Copy(p, raw, 0, raw.Length);
            return Parse(raw);
        }
    }

    /// <summary>Převod libovolného počtu kanálů na stereo (jako Web Audio: LFE pryč, střed a zadní do stran).</summary>
    public class Downmix
    {
        public readonly float[] Left;
        public readonly float[] Right;
        readonly int channels;
        readonly int bits;
        readonly bool isFloat;

        public Downmix(WaveFormat f)
        {
            channels = f.Channels;
            bits = f.BitsPerSample;
            isFloat = f.IsFloat;
            Left = new float[channels];
            Right = new float[channels];
            uint mask = f.ChannelMask != 0 ? f.ChannelMask : DefaultMask(channels);
            int c = 0;
            for (int bit = 0; bit < 32 && c < channels; bit++)
            {
                uint speaker = 1u << bit;
                if ((mask & speaker) == 0) continue;
                Weights(speaker, out Left[c], out Right[c]);
                c++;
            }
            // Kanály navíc (maska je kratší než počet kanálů): napůl do obou stran.
            for (; c < channels; c++)
            {
                Left[c] = 0.5f;
                Right[c] = 0.5f;
            }
            if (channels == 1)
            {
                Left[0] = 1f;
                Right[0] = 1f;
            }
        }

        public static uint DefaultMask(int channels)
        {
            switch (channels)
            {
                case 1: return 0x4;      // střed (mono)
                case 2: return 0x3;      // L R
                case 3: return 0x7;      // L R C
                case 4: return 0x33;     // L R + zadní
                case 5: return 0x37;     // L R C + zadní
                case 6: return 0x3F;     // 5.1
                case 7: return 0x13F;    // 6.1
                case 8: return 0x63F;    // 7.1 (zadní + boční)
                default: return 0x3;
            }
        }

        static void Weights(uint speaker, out float l, out float r)
        {
            const float h = 0.70710677f;
            switch (speaker)
            {
                case 0x1: l = 1f; r = 0f; return;         // přední levý
                case 0x2: l = 0f; r = 1f; return;         // přední pravý
                case 0x4: l = h; r = h; return;           // střed
                case 0x8: l = 0f; r = 0f; return;         // LFE (basy navíc) - jako Chromium / Web Audio vynechat
                case 0x10: l = h; r = 0f; return;         // zadní levý
                case 0x20: l = 0f; r = h; return;         // zadní pravý
                case 0x40: l = 0.9238795f; r = 0.38268343f; return; // přední levý střední
                case 0x80: l = 0.38268343f; r = 0.9238795f; return; // přední pravý střední
                case 0x100: l = 0.5f; r = 0.5f; return;   // zadní střed
                case 0x200: l = h; r = 0f; return;        // boční levý
                case 0x400: l = 0f; r = h; return;        // boční pravý
                default: l = 0.5f; r = 0.5f; return;      // horní a ostatní
            }
        }

        /// <summary>Vzorek jako float -1..1 (bajty jednoho vzorku na pozici).</summary>
        float Sample(byte[] data, int offset)
        {
            if (isFloat) return BitConverter.ToSingle(data, offset);
            if (bits == 16) return BitConverter.ToInt16(data, offset) / 32768f;
            if (bits == 24) return ((data[offset] << 8 | data[offset + 1] << 16 | data[offset + 2] << 24) >> 8) / 8388608f;
            return BitConverter.ToInt32(data, offset) / 2147483648f;
        }

        /// <summary>Převede `frames` snímků ze zdroje (bajty v jeho formátu) do `output` (L,R,L,R...) od `outOffset`.</summary>
        public void Convert(byte[] data, int frames, float[] output, int outOffset)
        {
            int bytes = bits / 8;
            int pos = 0;
            for (int i = 0; i < frames; i++)
            {
                float l = 0f, r = 0f;
                for (int c = 0; c < channels; c++)
                {
                    float s = Sample(data, pos);
                    pos += bytes;
                    l += s * Left[c];
                    r += s * Right[c];
                }
                // Součet kanálů může přetéct - ořezat (jinak by v nahrávce praskalo).
                output[outOffset++] = l > 1f ? 1f : (l < -1f ? -1f : l);
                output[outOffset++] = r > 1f ? 1f : (r < -1f ? -1f : r);
            }
        }
    }

    public static class Capture
    {
        const int ShareModeShared = 0;
        const int StreamFlagsLoopback = 0x00020000;
        const int BufferFlagsSilent = 0x2;
        const int ClsctxAll = 0x17;
        const int DeviceInvalidated = unchecked((int)0x88890004);
        /// <summary>E_NOTFOUND: žádný výchozí výstup (odpojená sluchátka, restart ovladače).</summary>
        const int NotFound = unchecked((int)0x80070490);
        const int BufferEmpty = 0x08890001;
        const int ERender = 0;
        const int EConsole = 0;

        static Stream output;
        static readonly object writeLock = new object();
        /// <summary>Zařízení už jednou šlo otevřít (poslal se formát) - když pak zmizí, čeká se, až zase bude.</summary>
        static bool opened;

        static void Send(byte type, byte[] payload, int length)
        {
            byte[] head = new byte[5];
            head[0] = type;
            head[1] = (byte)length;
            head[2] = (byte)(length >> 8);
            head[3] = (byte)(length >> 16);
            head[4] = (byte)(length >> 24);
            lock (writeLock)
            {
                output.Write(head, 0, 5);
                if (length > 0) output.Write(payload, 0, length);
                output.Flush();
            }
        }

        static void SendText(byte type, string text)
        {
            byte[] b = Encoding.UTF8.GetBytes(text ?? "");
            Send(type, b, b.Length);
        }

        /// <summary>Chyba = záporné HRESULT (kladné jsou úspěchy s poznámkou, třeba "zásobník je prázdný").</summary>
        static void Check(int hr, string what)
        {
            if (hr < 0) throw new COMException(what + " 0x" + hr.ToString("X8"), hr);
        }

        /// <summary>Appka skončila (zavřela stdin) -> konec i tady, ať pomocník nezůstane viset.</summary>
        static void WatchStdin()
        {
            try
            {
                Stream input = Console.OpenStandardInput();
                byte[] b = new byte[64];
                while (input.Read(b, 0, b.Length) > 0)
                {
                }
            }
            catch (Exception)
            {
            }
            Environment.Exit(0);
        }

        public static int Run()
        {
            output = Console.OpenStandardOutput();
            Thread watch = new Thread(WatchStdin);
            watch.IsBackground = true;
            watch.Start();
            byte[] magic = Encoding.ASCII.GetBytes("KLB1");
            lock (writeLock)
            {
                output.Write(magic, 0, magic.Length);
                output.Flush();
            }
            int result = 0;
            // WASAPI chce vlákno MTA (PowerShell běží v STA).
            Thread worker = new Thread(delegate ()
            {
                result = Loop();
            });
            try
            {
                worker.SetApartmentState(ApartmentState.MTA);
            }
            catch (Exception)
            {
                // mimo Windows (zkouška) apartmány nejsou
            }
            worker.Start();
            worker.Join();
            return result;
        }

        static int Loop()
        {
            // Zařízení zmizelo, změnilo formát (přepnutí 7.1, odpojení) nebo se přepnul výchozí výstup: otevřít znovu - nejvýš
            // 5x za minutu, pak to vzdát (appka nahrává dál bez zvuku hry a řekne proč).
            int[] reopenTimes = new int[5];
            int reopenIndex = 0;
            int goneSince = 0;
            while (true)
            {
                try
                {
                    CaptureDefaultDevice();
                    return 0;
                }
                catch (COMException e)
                {
                    // Výchozí výstup úplně zmizel (sluchátka odpojená, ovladač se restartuje): po
                    // prvním úspěšném otevření se čeká, až zase bude - nejvýš 2 minuty.
                    if (opened && e.ErrorCode == NotFound)
                    {
                        if (goneSince == 0) goneSince = Environment.TickCount;
                        if (Environment.TickCount - goneSince > 120000)
                        {
                            SendText((byte)'E', "no output device: " + e.Message);
                            return 2;
                        }
                        Thread.Sleep(2000);
                        continue;
                    }
                    goneSince = 0;
                    if (e.ErrorCode != DeviceInvalidated)
                    {
                        SendText((byte)'E', e.Message);
                        return 2;
                    }
                    int now = Environment.TickCount;
                    int oldest = reopenTimes[reopenIndex];
                    if (oldest != 0 && now - oldest < 60000)
                    {
                        SendText((byte)'E', "device keeps changing: " + e.Message);
                        return 2;
                    }
                    reopenTimes[reopenIndex] = now;
                    reopenIndex = (reopenIndex + 1) % reopenTimes.Length;
                    Thread.Sleep(300);
                }
                catch (IOException)
                {
                    return 0; // appka zavřela rouru
                }
                catch (Exception e)
                {
                    try { SendText((byte)'E', e.GetType().Name + ": " + e.Message); } catch (Exception) { }
                    return 2;
                }
            }
        }

        /// <summary>Id současného výchozího výstupu (null = teď žádný / nejde zjistit).</summary>
        static string DefaultDeviceId(IMMDeviceEnumerator enumerator)
        {
            IMMDevice now = null;
            try
            {
                if (enumerator.GetDefaultAudioEndpoint(ERender, EConsole, out now) != 0 || now == null) return null;
                string id;
                return now.GetId(out id) == 0 ? id : null;
            }
            catch (Exception)
            {
                return null;
            }
            finally
            {
                if (now != null) Marshal.ReleaseComObject(now);
            }
        }

        static void CaptureDefaultDevice()
        {
            IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());
            IMMDevice device = null;
            IAudioClient client = null;
            IAudioCaptureClient capture = null;
            IntPtr mixFormat = IntPtr.Zero;
            try
            {
                Check(enumerator.GetDefaultAudioEndpoint(ERender, EConsole, out device), "GetDefaultAudioEndpoint");
                string id;
                if (device.GetId(out id) != 0) id = "";
                Guid iidClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
                object o;
                Check(device.Activate(ref iidClient, ClsctxAll, IntPtr.Zero, out o), "Activate");
                client = (IAudioClient)o;
                Check(client.GetMixFormat(out mixFormat), "GetMixFormat");
                WaveFormat format = WaveFormat.FromPointer(mixFormat);
                // Sdílený režim, formát zařízení (ten Windows u loopbacku vždycky vezme), zásobník 200 ms.
                Check(client.Initialize(ShareModeShared, StreamFlagsLoopback, 2000000, 0, mixFormat, IntPtr.Zero), "Initialize");
                Guid iidCapture = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
                object c;
                Check(client.GetService(ref iidCapture, out c), "GetService");
                capture = (IAudioCaptureClient)c;
                Downmix mix = new Downmix(format);

                byte[] idBytes = Encoding.UTF8.GetBytes(id ?? "");
                byte[] head = new byte[12 + idBytes.Length];
                BitConverter.GetBytes((uint)format.SampleRate).CopyTo(head, 0);
                BitConverter.GetBytes((ushort)format.Channels).CopyTo(head, 4);
                BitConverter.GetBytes((uint)format.ChannelMask).CopyTo(head, 8);
                idBytes.CopyTo(head, 12);
                Send((byte)'F', head, head.Length);
                opened = true;

                Check(client.Start(), "Start");
                int lastDefaultCheck = Environment.TickCount;
                // Posílá se po ~20 ms (méně zpráv, pořád malé zpoždění).
                int chunkFrames = Math.Max(64, format.SampleRate / 50);
                float[] pending = new float[chunkFrames * 2 * 4];
                int pendingFrames = 0;
                byte[] raw = new byte[format.BlockAlign * 4096];
                byte[] outBytes = new byte[pending.Length * 4];
                while (true)
                {
                    Thread.Sleep(5);
                    // Výchozí výstup se přepnul (třeba z reproduktorů na sluchátka), staré zařízení
                    // ale zůstalo - zachytávání by běželo dál z něj a mlčelo. Jednou za vteřinu se
                    // zeptat a jít za ním (jako "Zvuk plochy" v OBS); znovu se otevře stejnou cestou
                    // jako po odpojení.
                    if (!string.IsNullOrEmpty(id) && Environment.TickCount - lastDefaultCheck >= 1000)
                    {
                        lastDefaultCheck = Environment.TickCount;
                        string current = DefaultDeviceId(enumerator);
                        if (!string.IsNullOrEmpty(current) && current != id)
                            throw new COMException("default output changed", DeviceInvalidated);
                    }
                    uint packet;
                    Check(capture.GetNextPacketSize(out packet), "GetNextPacketSize");
                    while (packet > 0)
                    {
                        IntPtr data;
                        uint frames, flags;
                        ulong devicePosition, qpc;
                        int got = capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpc);
                        if (got == BufferEmpty) break;
                        Check(got, "GetBuffer");
                        int n = (int)frames;
                        int bytes = n * format.BlockAlign;
                        if (raw.Length < bytes) raw = new byte[bytes];
                        if ((flags & BufferFlagsSilent) != 0) Array.Clear(raw, 0, bytes);
                        else Marshal.Copy(data, raw, 0, bytes);
                        Check(capture.ReleaseBuffer(frames), "ReleaseBuffer");
                        if ((pendingFrames + n) * 2 > pending.Length)
                        {
                            float[] bigger = new float[(pendingFrames + n) * 2 * 2];
                            Array.Copy(pending, bigger, pendingFrames * 2);
                            pending = bigger;
                            outBytes = new byte[bigger.Length * 4];
                        }
                        mix.Convert(raw, n, pending, pendingFrames * 2);
                        pendingFrames += n;
                        if (pendingFrames >= chunkFrames)
                        {
                            Buffer.BlockCopy(pending, 0, outBytes, 0, pendingFrames * 8);
                            Send((byte)'A', outBytes, pendingFrames * 8);
                            pendingFrames = 0;
                        }
                        Check(capture.GetNextPacketSize(out packet), "GetNextPacketSize");
                    }
                    // Nic dalšího nepřišlo (ticho - Windows pak loopbacku nic neposílá): odeslat zbytek hned.
                    if (pendingFrames > 0)
                    {
                        Buffer.BlockCopy(pending, 0, outBytes, 0, pendingFrames * 8);
                        Send((byte)'A', outBytes, pendingFrames * 8);
                        pendingFrames = 0;
                    }
                }
            }
            finally
            {
                if (client != null)
                {
                    try { client.Stop(); } catch (Exception) { }
                }
                if (mixFormat != IntPtr.Zero) Marshal.FreeCoTaskMem(mixFormat);
                if (capture != null) Marshal.ReleaseComObject(capture);
                if (client != null) Marshal.ReleaseComObject(client);
                if (device != null) Marshal.ReleaseComObject(device);
                Marshal.ReleaseComObject(enumerator);
            }
        }
    }
}
