export function LoadingSpinner() {
  return (
    <div className="loading-screen" role="status" aria-label="Loading" aria-live="polite">
      <div className="loading-motes" aria-hidden="true">
        {Array.from({ length: 16 }, (_, index) => <i key={index} />)}
      </div>

      <div className="loading-stage" aria-hidden="true">
        <div className="loading-glow" />

        <div className="loading-mascot">
          <svg viewBox="0 0 200 200" fill="none">
            <path className="loading-tent loading-tent-1" d="M58 118 C40 138,30 158,36 180" stroke="#9c4d24" strokeWidth="15" strokeLinecap="round" />
            <path className="loading-tent loading-tent-5" d="M142 118 C160 138,170 158,164 180" stroke="#9c4d24" strokeWidth="15" strokeLinecap="round" />
            <path className="loading-tent loading-tent-2" d="M80 128 C74 152,74 170,80 186" stroke="#c4622d" strokeWidth="15" strokeLinecap="round" />
            <path className="loading-tent loading-tent-4" d="M120 128 C126 152,126 170,120 186" stroke="#c4622d" strokeWidth="15" strokeLinecap="round" />
            <path className="loading-tent loading-tent-3" d="M100 130 L100 188" stroke="#b3572a" strokeWidth="15" strokeLinecap="round" />
            <ellipse cx="100" cy="84" rx="58" ry="52" fill="#c4622d" />
            <ellipse cx="100" cy="84" rx="58" ry="52" fill="url(#loadingBodyShade)" opacity=".5" />
            <path className="loading-horn" d="M76 46 C60 28,52 18,60 8" stroke="#c4622d" strokeWidth="10" strokeLinecap="round" />
            <ellipse className="loading-cheek" cx="62" cy="98" rx="9" ry="6" fill="#e8967a" />
            <g className="loading-eye">
              <circle cx="112" cy="78" r="23" fill="#f3ece1" />
              <circle cx="112" cy="78" r="23" fill="none" stroke="#00d9e8" strokeWidth="3" />
              <circle cx="116" cy="80" r="11" fill="#141010" />
              <circle cx="120" cy="75" r="3.4" fill="#f3ece1" />
            </g>
            <defs>
              <radialGradient id="loadingBodyShade" cx="35%" cy="30%" r="70%">
                <stop offset="0%" stopColor="#e8967a" />
                <stop offset="100%" stopColor="#9c4d24" stopOpacity="0" />
              </radialGradient>
            </defs>
          </svg>
        </div>

        <div className="loading-track"><i /></div>
      </div>
    </div>
  );
}

export function LoadingScreen() {
  return <LoadingSpinner />;
}
