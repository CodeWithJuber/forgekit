// Small XML helpers shared by the dependency gate and the verifier's Maven module reader.

/**
 * An XML document without its comments, read left to right as an XML parser reads it: `<!--`
 * inside a CDATA section is text, not a comment. A regex replace treats that `<!--` as a comment
 * and can strip a real <dependency> that follows it. Running the replace until nothing changes
 * would make this worse, since it also joins text from either side of a comment into a new
 * `<!--`. An unterminated comment is kept, so nothing after it is hidden from the gate.
 * @param {string} xml
 */
export function stripXmlComments(xml) {
  let out = "";
  let at = 0;
  for (;;) {
    const comment = xml.indexOf("<!--", at);
    if (comment < 0) break;
    const cdata = xml.indexOf("<![CDATA[", at);
    if (cdata >= 0 && cdata < comment) {
      const close = xml.indexOf("]]>", cdata + 9);
      const end = close < 0 ? xml.length : close + 3;
      out += xml.slice(at, end);
      at = end;
      continue;
    }
    const close = xml.indexOf("-->", comment + 4);
    if (close < 0) break;
    out += xml.slice(at, comment);
    at = close + 3;
  }
  return out + xml.slice(at);
}
