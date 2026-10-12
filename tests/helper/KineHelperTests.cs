// Testy čisté logiky pomocníka (src/helper/KineHelper.cs). Překládá a pouští
// je tests/helper.test.mjs: na Windows csc.exe z .NET Frameworku, jinde mono (mcs).
using System;
using System.Collections.Generic;
using KineHelper;

namespace KineHelperTests
{
    public static class Program
    {
        static int failed;
        static int passed;

        static void Check(string name, bool ok, string detail)
        {
            if (ok) { passed++; Console.WriteLine("OK    " + name); }
            else { failed++; Console.WriteLine("CHYBA " + name + (detail != null ? " :: " + detail : "")); }
        }

        static string Show(int[][] chords)
        {
            List<string> parts = new List<string>();
            foreach (int[] c in chords) parts.Add(string.Join(",", Array.ConvertAll(c, x => x.ToString())));
            return string.Join(";", parts.ToArray());
        }

        static string Show(List<int> list)
        {
            return string.Join(",", list.ConvertAll(x => x.ToString()).ToArray());
        }

        public static int Main(string[] args)
        {
            // Zkratky z prostředí (stejný formát jako PowerShell skript).
            Check("zkratky: F8 a Ctrl+F9", Show(Logic.ParseChords("119;17,120")) == "119;17,120", Show(Logic.ParseChords("119;17,120")));
            Check("zkratky: prázdné", Logic.ParseChords("").Length == 0 && Logic.ParseChords(null).Length == 0 && Logic.ParseChords(";;").Length == 0, null);
            Check("zkratky: rozbitý kus se přeskočí", Show(Logic.ParseChords("119;a,5; 120 ")) == "119;120", Show(Logic.ParseChords("119;a,5; 120 ")));
            Check("ovladač: kód od 0x100000", Logic.UsesPad(Logic.ParseChords("119;1048577")) && !Logic.UsesPad(Logic.ParseChords("119;17,120")), null);

            // Časování jako ve skriptu (nastavení výkonu: úsporné / vyvážené / výkonné).
            Check("časy: vyvážené bez zkratek", string.Join(",", Array.ConvertAll(Logic.Timing(false, 30, 1000, 5), x => x.ToString())) == "1000,1,5", null);
            Check("časy: vyvážené se zkratkami", string.Join(",", Array.ConvertAll(Logic.Timing(true, 30, 1000, 5), x => x.ToString())) == "30,33,167", null);
            Check("časy: úsporné se zkratkami", string.Join(",", Array.ConvertAll(Logic.Timing(true, 50, 2000, 10), x => x.ToString())) == "50,40,200", null);
            Check("časy: výkonné se zkratkami", string.Join(",", Array.ConvertAll(Logic.Timing(true, 15, 500, 3), x => x.ToString())) == "15,33,200", null);
            Check("časy: z prostředí, minimum a výchozí", Logic.EnvInt("3", 30, 5) == 5 && Logic.EnvInt("abc", 30, 5) == 30 && Logic.EnvInt(null, 1000, 100) == 1000 && Logic.EnvInt(" 250 ", 1000, 100) == 250, null);
            Check("procesy: 1. kolo a pak každé N-té", Logic.ProcTick(1, 5) && !Logic.ProcTick(2, 5) && Logic.ProcTick(6, 5) && !Logic.ProcTick(5, 5), null);
            Check("procesy: N = 1 každé kolo", Logic.ProcTick(1, 1) && Logic.ProcTick(2, 1) && Logic.ProcTick(7, 1), null);

            // Náběžná hrana a "delší kombinace vyhrává" (F8 vs Ctrl+F8).
            int[][] chords = Logic.ParseChords("119;17,119;120");
            bool[] was = new bool[chords.Length];
            List<int> fired = Logic.NewlyPressed(new bool[] { true, true, false }, was, chords);
            Check("Ctrl+F8: jen delší kombinace", Show(fired) == "1", Show(fired));
            fired = Logic.NewlyPressed(new bool[] { true, true, false }, was, chords);
            Check("držená zkratka se neopakuje", fired.Count == 0, Show(fired));
            fired = Logic.NewlyPressed(new bool[] { true, false, false }, was, chords);
            Check("puštěný Ctrl s drženým F8 nic nespustí", fired.Count == 0, Show(fired));
            fired = Logic.NewlyPressed(new bool[] { false, false, false }, was, chords);
            fired = Logic.NewlyPressed(new bool[] { true, false, true }, was, chords);
            Check("F8 a F9 naráz", Show(fired) == "0,2", Show(fired));

            // Celá obrazovka: kryje monitor a nemá titulek.
            Check("fullscreen bez rámečku", Logic.IsFullscreen(1920, 1080, 1920, 1080, 0x10000000), null);
            Check("maximalizované okno s titulkem není fullscreen", !Logic.IsFullscreen(1920, 1080, 1920, 1080, 0x10C00000), null);
            Check("menší okno není fullscreen", !Logic.IsFullscreen(1280, 720, 1920, 1080, 0), null);
            Check("neznámý monitor", !Logic.IsFullscreen(1920, 1080, 0, 0, 0), null);

            // JSON pro appku.
            Check("JSON: uvozovky, lomítka, řídicí znaky, čeština",
                Logic.Str("a\"b\\c\nd\te\u0001ž") == "\"a\\\"b\\\\c\\nd\\te\\u0001ž\"", Logic.Str("a\"b\\c\nd\te\u0001ž"));
            Check("JSON: null", Logic.Str(null) == "\"\"", null);
            string fg = Logic.FgJson(1234, "cs2.exe", "Counter-Strike \"2\"", 1920, 1080, true);
            Check("JSON: okno v popředí", fg == "{\"t\":\"fg\",\"pid\":1234,\"exe\":\"cs2.exe\",\"title\":\"Counter-Strike \\\"2\\\"\",\"w\":1920,\"h\":1080,\"fs\":true}", fg);
            HashSet<string> set = new HashSet<string>(StringComparer.Ordinal);
            set.Add("steam.exe"); set.Add("cs2.exe"); set.Add("explorer.exe");
            string procs = Logic.ProcsJson(Logic.Sorted(set), new string[0], 730);
            Check("JSON: procesy seřazené, prázdné pole, Steam", procs == "{\"t\":\"procs\",\"exes\":[\"cs2.exe\",\"explorer.exe\",\"steam.exe\"],\"win\":[],\"steam\":730}", procs);
            Check("JSON: chyba", Logic.ErrJson("x\"y") == "{\"t\":\"err\",\"m\":\"x\\\"y\"}", Logic.ErrJson("x\"y"));

            Console.WriteLine();
            Console.WriteLine(passed + " prošlo, " + failed + " spadlo");
            return failed == 0 ? 0 : 1;
        }
    }
}
