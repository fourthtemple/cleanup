/*
Paste this into the bird-weight-editor browser console after reproducing a
Source -> Region -> Clone issue. It copies replay JSON to the clipboard and
also prints it to the console.
*/
(async () => {
  const helper = window.mixamoCleanupCloneReplay;
  if (!helper) {
    throw new Error("Clone paint replay helper is not loaded. Reload the editor and try again.");
  }
  const json = await helper.copy();
  console.log("Clone paint replay JSON copied. Paste it into the Codex thread.");
  return json;
})();

