export function OctoMark({ large = false }: { large?: boolean }) {
  if (!large) {
    return (
      <svg className="octo-mark octo-mark-brand" viewBox="0 0 200 200" role="img" aria-label="Octomynd">
        <ellipse cx="100" cy="82" rx="54" ry="48" fill="#c4622d" />
        <path d="M56 116 C40 138,32 158,38 178" stroke="#c4622d" strokeWidth="11" strokeLinecap="round" />
        <path d="M144 116 C160 138,168 158,162 178" stroke="#c4622d" strokeWidth="11" strokeLinecap="round" />
        <path d="M80 126 C75 148,75 164,80 180" stroke="#9c4d24" strokeWidth="11" strokeLinecap="round" />
        <path d="M120 126 C125 148,125 164,120 180" stroke="#9c4d24" strokeWidth="11" strokeLinecap="round" />
        <path d="M100 128 L100 182" stroke="#9c4d24" strokeWidth="11" strokeLinecap="round" />
        <g className="octo-eye-look">
          <circle cx="120" cy="76" r="17" fill="#f3ece1" />
          <circle cx="120" cy="76" r="9" fill="#14110f" />
          <circle cx="124" cy="72" r="3" fill="#f3ece1" />
        </g>
        <path className="octo-eye-lid" d="M103 76 C106 60,134 58,137 76 C131 66,109 66,103 76Z" fill="#c4622d" />
      </svg>
    );
  }

  return (
    <svg className={large ? "octo-mark is-large" : "octo-mark"} viewBox="0 0 96 96" role="img" aria-label="Octomynd">
      <defs>
        <linearGradient id="octoBody" x1="20" y1="8" x2="78" y2="86">
          <stop stopColor="#c4622d" />
          <stop offset="1" stopColor="#9c4d24" />
        </linearGradient>
      </defs>
      <path
        fill="url(#octoBody)"
        d="M24 39C24 19 38 8 55 11C73 14 82 29 76 46C72 58 65 63 60 66C68 66 76 70 76 78C76 85 67 87 61 80C56 74 54 69 50 69C47 69 48 79 42 83C35 88 28 82 31 75C33 70 38 67 34 65C30 63 27 73 19 74C11 75 9 66 15 61C20 57 27 56 29 52C26 49 24 44 24 39Z"
      />
      <path fill="#e8967a" d="M28 26C21 19 25 10 33 13C39 15 38 23 32 29Z" />
      <circle cx="58" cy="35" r="15" fill="#14110f" />
      <g className="octo-eye-look">
        <circle cx="60" cy="34" r="9" fill="#f3ece1" />
        <circle cx="62" cy="33" r="5" fill="#1c1712" />
        <circle cx="64" cy="32" r="2" fill="#f3ece1" />
      </g>
      <path className="octo-eye-lid" d="M44 35C47 24 68 21 73 35C68 28 50 28 44 35Z" fill="#c4622d" />
      <path d="M35 49C42 55 51 55 57 49" fill="none" stroke="#9c4d24" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
