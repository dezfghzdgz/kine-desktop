/** Zdrojáky pomocníků v C# se do hlavního procesu přibalí jako text (scripts/build.mjs, loader '.cs'). */
declare module '*.cs' {
  const source: string;
  export default source;
}
