/* tni.js — the suite's icon set (window.TNI). Lucide-style line icons, 24px grid,
   1.5 stroke, currentColor. The same vocabulary Insight, Vault, TradeHub and MyList
   draw from, so a "lock" or "refresh" is identical everywhere in the suite. It
   replaced the emoji glyphs Tony's chrome used to render; Veda's apps are untouched.
   Sizing is owned by the CSS/inline style of each host, not the SVG.
   index.html loads it; Notebook loads it into a host that has no window.TNI. */
(function(){
  function I(body){
    return '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" '
         + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  }
  window.TNI = {
    lock:      I('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
    unlock:    I('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>'),
    key:       I('<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 8.5-8.5"/><path d="m17 6 3 3"/><path d="m14 9 3 3"/>'),
    shield:    I('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>'),
    user:      I('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
    trash:     I('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
    pencil:    I('<path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>'),
    x:         I('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
    check:     I('<path d="M20 6 9 17l-5-5"/>'),
    play:      I('<path d="M7 4.5v15l12-7.5Z"/>'),
    alert:     I('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
    bell:      I('<path d="M18 9a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>'),
    // Solid counterpart for the small reminder chips, where the outline bell's
    // hairlines close up and read as a smudge.
    bellFill:  '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" stroke="none" aria-hidden="true">'
             + '<path d="M12 2.2a6.3 6.3 0 0 0-6.3 6.3c0 3.3-.8 5.4-1.6 6.6-.6 1 .1 2.2 1.3 2.2h13.2c1.2 0 1.9-1.2 1.3-2.2-.8-1.2-1.6-3.3-1.6-6.6A6.3 6.3 0 0 0 12 2.2Z"/>'
             + '<path d="M9.4 18.9a2.7 2.7 0 0 0 5.2 0Z"/></svg>',
    phone:     I('<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>'),
    calendar:  I('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4"/><path d="M16 3v4"/>'),
    chartUp:   I('<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="m7 15 4-4 3 3 5-6"/>'),
    bank:      I('<path d="m3 9 9-6 9 6"/><path d="M4 9v10"/><path d="M20 9v10"/><path d="M9 9v10"/><path d="M15 9v10"/><path d="M2 21h20"/>'),
    cloud:     I('<path d="M12 13v8"/><path d="m8 17 4-4 4 4"/><path d="M20.9 18.4A5 5 0 0 0 18 9h-1.3A8 8 0 1 0 4 16.2"/>'),
    download:  I('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>'),
    copy:      I('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    eye:       I('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'),
    clip:      I('<path d="M21.4 11 12.3 20a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.9-2.9l8.5-8.5"/>'),
    folder:    I('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>'),
    image:     I('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="m4 18 5-5 4 4 3-3 4 4"/>'),
    doc:       I('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h8"/>'),
    notes:     I('<path d="M4 4h16v12l-4 4H4Z"/><path d="M20 16h-4v4"/><path d="M8 9h8"/><path d="M8 13h5"/>'),
    clipboard: I('<rect x="6" y="4" width="12" height="18" rx="2"/><path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="M9 11h6"/><path d="M9 15h4"/>'),
    brain:     I('<path d="M12 5a3 3 0 0 0-6 0 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1Z"/><path d="M12 5a3 3 0 0 1 6 0 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1Z"/>'),
    pen:       I('<path d="M12 19H5a2 2 0 0 1 0-4h5a2 2 0 0 0 0-4H7"/><path d="M17.5 3.5a2.1 2.1 0 0 1 3 3L15 12l-4 1 1-4Z"/>'),
    sparkle:   I('<path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z"/><path d="M18.5 15.5 19 17l1.5.5L19 18l-.5 1.5L18 18l-1.5-.5L18 17Z"/>'),
    palette:   I('<path d="M12 21a9 9 0 1 1 9-9c0 2-1.6 3-3 3h-2a2 2 0 0 0-1.4 3.4A2 2 0 0 1 12 21Z"/><circle cx="7.5" cy="12" r="1.2"/><circle cx="10" cy="8" r="1.2"/><circle cx="15" cy="8.5" r="1.2"/>'),
    undo:      I('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/>'),
    redo:      I('<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h4"/>'),
    rotateCcw: I('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>'),
    refresh:   I('<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>'),
    arrowUp:   I('<path d="M12 20V5"/><path d="m6 11 6-6 6 6"/>'),
    arrowDown: I('<path d="M12 4v15"/><path d="m6 13 6 6 6-6"/>'),
    clock:     I('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    trophy:    I('<path d="M7 4h10v6a5 5 0 0 1-10 0Z"/><path d="M7 6H4a3 3 0 0 0 3 3"/><path d="M17 6h3a3 3 0 0 1-3 3"/><path d="M10 15h4l1 5H9Z"/>'),
    dot:       I('<circle cx="12" cy="12" r="5" fill="currentColor"/>'),
    star:      I('<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 9.6l6.2-.9Z"/>'),
    // Fullscreen pair — four corners pushing out / pulling back in.
    expand:    I('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>'),
    shrink:    I('<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>')
  };
  window.TNI.starOn = window.TNI.star.replace('fill="none"','fill="currentColor"');
})();
