<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 420" width="960" height="420" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif" role="img" aria-label="ForgeKit connects project evidence, change-impact checks and verification to coding agents through native configuration and MCP.">
  <defs>
    <radialGradient id="glowL" cx="30%" cy="35%" r="75%">
      <stop offset="0%" stop-color="{{brand}}" stop-opacity="0.10"/>
      <stop offset="70%" stop-color="{{brand}}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="emberL" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="{{brand}}"/>
      <stop offset="100%" stop-color="{{brand-2}}"/>
    </linearGradient>
  </defs>

  <rect width="960" height="420" rx="20" fill="{{bg}}"/>
  <rect width="960" height="420" rx="20" fill="url(#glowL)"/>
  <rect x="0.75" y="0.75" width="958.5" height="418.5" rx="19" fill="none" stroke="{{line}}" stroke-width="1.5"/>

  <!-- wordmark -->
  <g transform="translate(40,40)">
    <path d="M12 0 14.2 7.2 21.5 7.5 15.7 11.9 18 19 12 14.6 6 19 8.3 11.9 2.5 7.5 9.8 7.2Z" fill="{{brand}}"/>
    <text x="34" y="15" font-size="19" font-weight="700" fill="{{text}}">forge<tspan fill="{{brand-2}}">kit</tspan></text>
  </g>
  <text x="40" y="92" font-size="13" letter-spacing="0.14em" fill="{{brand-2}}" font-weight="600">PROJECT EVIDENCE FOR CODING AGENTS</text>

  <!-- LEFT: the stateless model -->
  <g transform="translate(60,150)">
    <rect x="0" y="0" width="196" height="150" rx="14" fill="{{panel}}" stroke="{{line}}" stroke-width="1.5"/>
    <text x="98" y="34" text-anchor="middle" font-size="14" font-weight="700" fill="{{text}}">model request</text>
    <text x="98" y="56" text-anchor="middle" font-size="11.5" fill="{{muted}}">task and selected evidence</text>
    <text x="98" y="72" text-anchor="middle" font-size="11.5" fill="{{muted}}">in a bounded context</text>
    <g stroke="{{faint}}" stroke-width="1.5" fill="none" opacity="0.8">
      <path d="M52 96 a20 20 0 1 1 -8 12"/>
      <path d="M44 108 l-1 12 l11 -5 Z" fill="{{faint}}" stroke="none"/>
    </g>
    <text x="112" y="112" font-size="11" fill="{{faint}}">tool results</text>
    <text x="112" y="128" font-size="11" fill="{{faint}}">enter next turn</text>
  </g>

  <!-- MIDDLE: the substrate ring -->
  <g transform="translate(360,150)">
    <rect x="0" y="-6" width="232" height="168" rx="16" fill="{{panel}}" stroke="{{brand}}" stroke-width="1.5"/>
    <text x="116" y="18" text-anchor="middle" font-size="13" font-weight="700" fill="{{brand-2}}">project evidence and checks</text>
    <g transform="translate(16,34)">
      <rect x="0" y="0" width="200" height="34" rx="9" fill="{{panel-2}}" stroke="{{line}}" stroke-width="1"/>
      <circle cx="20" cy="17" r="5" fill="{{brand}}"/>
      <text x="36" y="16" font-size="12.5" font-weight="600" fill="{{text}}">memory</text>
      <text x="36" y="29" font-size="10.5" fill="{{muted}}">claims linked to evidence</text>
    </g>
    <g transform="translate(16,74)">
      <rect x="0" y="0" width="200" height="34" rx="9" fill="{{panel-2}}" stroke="{{line}}" stroke-width="1"/>
      <circle cx="20" cy="17" r="5" fill="{{brand}}"/>
      <text x="36" y="16" font-size="12.5" font-weight="600" fill="{{text}}">change impact</text>
      <text x="36" y="29" font-size="10.5" fill="{{muted}}">estimates affected files</text>
    </g>
    <g transform="translate(16,114)">
      <rect x="0" y="0" width="200" height="34" rx="9" fill="{{panel-2}}" stroke="{{line}}" stroke-width="1"/>
      <circle cx="20" cy="17" r="5" fill="{{brand}}"/>
      <text x="36" y="16" font-size="12.5" font-weight="600" fill="{{text}}">guardrails</text>
      <text x="36" y="29" font-size="10.5" fill="{{muted}}">hook and tool policy checks</text>
    </g>
  </g>

  <!-- arrow: model -> substrate -->
  <g stroke="{{brand}}" stroke-width="2" fill="none">
    <path d="M256 225 L352 225"/>
    <path d="M352 225 l-11 -5 l0 10 Z" fill="{{brand}}" stroke="none"/>
  </g>

  <!-- RIGHT: selected host adapters -->
  <g transform="translate(700,150)">
    <rect x="0" y="-6" width="200" height="168" rx="16" fill="{{panel}}" stroke="{{line}}" stroke-width="1.5"/>
    <rect x="16" y="16" width="168" height="32" rx="9" fill="url(#emberL)"/>
    <text x="100" y="37" text-anchor="middle" font-size="13" font-weight="700" fill="{{on-brand}}">coding hosts</text>
    <g font-size="10.5" fill="{{text}}">
{{hosts}}
    </g>
  </g>

  <!-- arrow: substrate -> config -->
  <g stroke="{{brand}}" stroke-width="2" fill="none">
    <path d="M592 225 L692 225"/>
    <path d="M692 225 l-11 -5 l0 10 Z" fill="{{brand}}" stroke="none"/>
  </g>

  <!-- footer strip -->
  <text x="480" y="356" text-anchor="middle" font-size="12" fill="{{muted}}">Supervised runs check tool permissions, enforce budgets and verify the result.</text>
  <text x="480" y="388" text-anchor="middle" font-size="11.5" fill="{{faint}}">Repository rules · CLI and MCP · host-specific hooks</text>
</svg>
