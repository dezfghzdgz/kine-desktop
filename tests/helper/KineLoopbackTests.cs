// Testy převodu zvuku pomocníka KineLoopback (src/helper/KineLoopback.cs):
// formát zařízení z WAVEFORMATEX(TENSIBLE) a převod na stereo. Bez Windows
// (WASAPI tu není) - přeloží a spustí je tests/loopback.test.mjs (mcs -langversion:5).

using System;
using KineLoopback;

namespace KineLoopbackTests
{
    public static class Program
    {
        static int passed;
        static int failed;

        static void Check(bool ok, string name)
        {
            if (ok) passed++;
            else
            {
                failed++;
                Console.WriteLine("CHYBA " + name);
            }
        }

        static bool Near(float a, float b)
        {
            return Math.Abs(a - b) < 1e-4f;
        }

        static byte[] Basic(int tag, int channels, int rate, int bits)
        {
            byte[] b = new byte[18];
            BitConverter.GetBytes((ushort)tag).CopyTo(b, 0);
            BitConverter.GetBytes((ushort)channels).CopyTo(b, 2);
            BitConverter.GetBytes((uint)rate).CopyTo(b, 4);
            BitConverter.GetBytes((uint)(rate * channels * bits / 8)).CopyTo(b, 8);
            BitConverter.GetBytes((ushort)(channels * bits / 8)).CopyTo(b, 12);
            BitConverter.GetBytes((ushort)bits).CopyTo(b, 14);
            return b;
        }

        static byte[] Extensible(int channels, int rate, int bits, bool isFloat, uint mask)
        {
            byte[] b = new byte[40];
            Basic(0xFFFE, channels, rate, bits).CopyTo(b, 0);
            BitConverter.GetBytes((ushort)22).CopyTo(b, 16);
            BitConverter.GetBytes((ushort)bits).CopyTo(b, 18);
            BitConverter.GetBytes(mask).CopyTo(b, 20);
            Guid sub = isFloat ? new Guid("00000003-0000-0010-8000-00aa00389b71") : new Guid("00000001-0000-0010-8000-00aa00389b71");
            sub.ToByteArray().CopyTo(b, 24);
            return b;
        }

        static float[] One(Downmix d, byte[] raw)
        {
            float[] o = new float[2];
            d.Convert(raw, 1, o, 0);
            return o;
        }

        static byte[] Floats(float[] values)
        {
            byte[] raw = new byte[values.Length * 4];
            Buffer.BlockCopy(values, 0, raw, 0, raw.Length);
            return raw;
        }

        public static int Main()
        {
            const float h = 0.70710677f;

            // Virtuální 7.1 (Logitech G HUB a spol.): float32, L R C LFE BL BR SL SR.
            WaveFormat f = WaveFormat.Parse(Extensible(8, 48000, 32, true, 0x63F));
            Check(f.Channels == 8 && f.SampleRate == 48000 && f.IsFloat && f.ChannelMask == 0x63F && f.BlockAlign == 32, "7.1 float: formát");
            Downmix d = new Downmix(f);
            float[] o = One(d, Floats(new float[] { 0.5f, 0f, 0.2f, 1f, 0.1f, 0f, 0f, 0.3f }));
            Check(Near(o[0], 0.5f + 0.2f * h + 0.1f * h), "7.1: levá = L + střed + zadní levý");
            Check(Near(o[1], 0.2f * h + 0.3f * h), "7.1: pravá = střed + boční pravý, LFE pryč");
            o = One(d, Floats(new float[] { 1f, -1f, 1f, 0f, 1f, -1f, 1f, -1f }));
            Check(o[0] == 1f && o[1] == -1f, "7.1: součet přes 1 se ořízne");

            // Více snímků za sebou, výstup od posunu.
            float[] many = new float[6];
            d.Convert(Floats(new float[] { 0.1f, 0.2f, 0f, 0f, 0f, 0f, 0f, 0f, 0.3f, 0.4f, 0f, 0f, 0f, 0f, 0f, 0f }), 2, many, 2);
            Check(many[0] == 0f && Near(many[2], 0.1f) && Near(many[3], 0.2f) && Near(many[4], 0.3f) && Near(many[5], 0.4f), "víc snímků od posunu");

            // 5.1 bez masky (WAVEFORMATEX, float): výchozí rozložení L R C LFE BL BR.
            WaveFormat f51 = WaveFormat.Parse(Basic(3, 6, 44100, 32));
            Downmix d51 = new Downmix(f51);
            o = One(d51, Floats(new float[] { 0f, 0f, 0.4f, 0.9f, 0f, 0.2f }));
            Check(f51.SampleRate == 44100 && Near(o[0], 0.4f * h) && Near(o[1], 0.4f * h + 0.2f * h), "5.1 bez masky");

            // Obyčejné stereo 16 bit (WAVE_FORMAT_PCM).
            WaveFormat f16 = WaveFormat.Parse(Basic(1, 2, 48000, 16));
            byte[] raw16 = new byte[4];
            BitConverter.GetBytes((short)16384).CopyTo(raw16, 0);
            BitConverter.GetBytes((short)-32768).CopyTo(raw16, 2);
            o = One(new Downmix(f16), raw16);
            Check(!f16.IsFloat && Near(o[0], 0.5f) && Near(o[1], -1f), "stereo 16 bit");

            // 24 bit (EXTENSIBLE PCM): 0x400000 = 0,5, 0xC00000 = -0,5.
            WaveFormat f24 = WaveFormat.Parse(Extensible(2, 96000, 24, false, 0x3));
            o = One(new Downmix(f24), new byte[] { 0x00, 0x00, 0x40, 0x00, 0x00, 0xC0 });
            Check(f24.BlockAlign == 6 && Near(o[0], 0.5f) && Near(o[1], -0.5f), "stereo 24 bit");

            // 32 bit celá čísla (24 platných v 32bitovém kontejneru).
            WaveFormat f32 = WaveFormat.Parse(Extensible(2, 48000, 32, false, 0x3));
            byte[] raw32 = new byte[8];
            BitConverter.GetBytes(1 << 30).CopyTo(raw32, 0);
            BitConverter.GetBytes(int.MinValue).CopyTo(raw32, 4);
            o = One(new Downmix(f32), raw32);
            Check(Near(o[0], 0.5f) && Near(o[1], -1f), "stereo 32 bit celá čísla");

            // Mono (USB mikrofon jako výstup? i to) do obou stran.
            WaveFormat mono = WaveFormat.Parse(Basic(3, 1, 48000, 32));
            o = One(new Downmix(mono), Floats(new float[] { 0.25f }));
            Check(Near(o[0], 0.25f) && Near(o[1], 0.25f), "mono do obou stran");

            // Nepodporované: ADPCM, nesmyslná frekvence, nesedící zarovnání.
            int rejected = 0;
            byte[][] bad = { Basic(2, 2, 48000, 16), Basic(3, 2, 1000, 32), Basic(1, 2, 48000, 12) };
            foreach (byte[] b in bad)
            {
                try
                {
                    WaveFormat.Parse(b);
                }
                catch (NotSupportedException)
                {
                    rejected++;
                }
            }
            byte[] misaligned = Basic(3, 2, 48000, 32);
            BitConverter.GetBytes((ushort)6).CopyTo(misaligned, 12);
            try
            {
                WaveFormat.Parse(misaligned);
            }
            catch (NotSupportedException)
            {
                rejected++;
            }
            Check(rejected == 4, "nepodporované formáty se odmítnou");

            Check(Downmix.DefaultMask(8) == 0x63F && Downmix.DefaultMask(6) == 0x3F && Downmix.DefaultMask(2) == 0x3, "výchozí masky");

            Console.WriteLine(passed + " prošlo, " + failed + " spadlo");
            return failed == 0 ? 0 : 1;
        }
    }
}
