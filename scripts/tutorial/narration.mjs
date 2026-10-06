// The voice-over, one entry per beat. `id` ties a line to its action in
// record.mjs; the line is spoken while that action plays, and shown as the
// caption. tts.mjs respells a few words for the voice only (see SPOKEN).
export const NARRATION = [
  ["title", "Welcome to Open Poly: a free 3D CAD tool that runs right in your browser."],
  [
    "opensource",
    "It's open-source and lightweight enough to run locally, or you can use it at open-poly.pages.dev. Either way, your designs stay on your machine, not in the cloud.",
  ],
  ["dive", "So let's dive right in."],
  ["center", "In the center you can see the model being worked on."],
  ["timeline", "On the left is the timeline, which lists every step of your model, in order."],
  ["toolbar", "And across the top is the toolbar, with all the modeling tools."],
  ["cube", "Up in the corner is the view cube. Click any face to jump straight to that view, like the front,"],
  ["cubeCorner", "or click one of its corners for an isometric view."],
  ["orbit", "You can also left-click and drag anywhere in the view to orbit,"],
  ["panZoom", "right-drag to pan, and scroll to zoom."],
  [
    "home",
    "And if you ever get lost, click the home button for a clean isometric view of all of the parts in the scene.",
  ],
  ["new", "Now let's make our own part. Click New to start a fresh document."],
  ["sketch", "Every solid starts with a 2D sketch. Click Sketch, and pick the top plane as your drawing surface."],
  [
    "rect",
    "Press Shift R for the center rectangle, or choose it from the sketch toolbar. Click the origin, then click again to place a corner.",
  ],
  ["dimW", "Don't worry about being exact. Select an edge, press D, and type a length: sixty millimeters wide,"],
  ["dimH", "and forty deep."],
  [
    "circle",
    "Now draw a circle in the middle for a hole. Press C, or pick the circle tool from the sketch toolbar, and give it a diameter of sixteen.",
  ],
  ["finish", "When you're happy with it, click Finish sketch."],
  [
    "variable",
    "Before we extrude, let's add a variable, so the plate's thickness can be referenced in one place. Click plus Variable, name it thickness, and set it to eight.",
  ],
  ["extrude", "Now let's turn the sketch into a solid. Press H for the home view, then click Extrude."],
  ["extrudeSet", "Click the region, type thickness as the distance, and click Create."],
  ["plate", "And there's our plate, with the hole cut right through it."],
  [
    "varChange",
    "Now change thickness to twelve, and the plate updates to match. Anything that uses the variable follows along.",
  ],
  ["fillet", "To soften the sharp edges, choose Fillet, and click the top face to round all of its edges."],
  ["filletSet", "Set the radius to two, and click Create."],
  ["hints", "Most tools have a keyboard shortcut. Press the question mark key to see them right on the buttons."],
  ["keys", "S for sketch, E for extrude, F for fillet, and the number keys for standard views."],
  ["undo", "You can undo any step with Command Z, or the undo button,"],
  ["redo", "and redo it with Command Shift Z, or the redo button."],
  ["name", "Finally, let's 3D print it. Give the part a name in the parts list,"],
  ["stl", "then click S T L. That downloads a mesh file you can drop straight into your slicer."],
  ["basics", "That's the basics of Open Poly."],
  [
    "next",
    "In the next video, we'll run it locally, and connect Claude, or any AI agent you like, to help with your modeling, or build the whole model for you.",
  ],
  ["bye", "Thanks for watching!"],
];

// How the voice should say words it would otherwise get wrong. Captions keep the
// written form. Each respelling below was checked against the same `phonemizer`
// package Kokoro phonemizes with, so these are the actual G2P outputs, not
// guesses:
//   CAD    → spelled out letter by letter; "cad" gives /kad/.
//   3D/2D  → two stressed syllables; "threedee" gives a natural /ˈθriːdiː/.
//   fillet → /fɪlˈeɪ/, the French "fil-LAY" with a silent t. "fillit" gives
//            /ˈfɪlɪt/, which is how the tool is said in English CAD.
//   URL    → Kokoro splits text on "." before phonemizing, so the address
//            would be read as three clipped sentences; spell the dots out.
export const SPOKEN = [
  [/\bCAD\b/g, "cad"],
  [/\b3D\b/g, "threedee"],
  [/\b2D\b/g, "twodee"],
  [/\bfillet\b/gi, "fillit"],
  [/open-poly\.pages\.dev/g, "open poly dot pages dot dev"],
];
