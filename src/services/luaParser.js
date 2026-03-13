// LuaParser — lightweight parser for WoW SavedVariables format
// Handles: strings, numbers, booleans, nil, nested tables, arrays, comments
// Does NOT handle: metatables, functions, userdata — WoW SVs don't use these

class LuaParser {
  parse(luaSource) {
    // Remove Lua comments
    let src = luaSource.replace(/--\[\[[\s\S]*?\]\]/g, ""); // block comments
    src = src.replace(/--[^\n]*/g, ""); // line comments

    const result = {};
    // Match top-level assignments: VarName = { ... }
    const assignRegex = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*/g;
    let match;

    while ((match = assignRegex.exec(src)) !== null) {
      const varName = match[1];
      const startIdx = match.index + match[0].length;
      try {
        const [value] = this._parseValue(src, startIdx);
        result[varName] = value;
      } catch (e) {
        console.warn(`[LuaParser] Failed to parse ${varName}:`, e.message);
      }
    }

    return result;
  }

  _parseValue(src, idx) {
    idx = this._skipWhitespace(src, idx);
    const ch = src[idx];

    if (ch === "{") return this._parseTable(src, idx);
    if (ch === '"' || ch === "'") return this._parseString(src, idx);
    if (ch === "-" || (ch >= "0" && ch <= "9")) return this._parseNumber(src, idx);
    if (src.substring(idx, idx + 4) === "true") return [true, idx + 4];
    if (src.substring(idx, idx + 5) === "false") return [false, idx + 5];
    if (src.substring(idx, idx + 3) === "nil") return [null, idx + 3];

    throw new Error(`Unexpected character '${ch}' at position ${idx}`);
  }

  _parseTable(src, idx) {
    idx++; // skip opening {
    idx = this._skipWhitespace(src, idx);

    const entries = [];
    const stringKeys = {};
    let arrayIndex = 1;
    let isArray = true;

    while (idx < src.length && src[idx] !== "}") {
      idx = this._skipWhitespace(src, idx);
      if (src[idx] === "}") break;

      // Check for explicit key: [number] = value  OR  ["string"] = value  OR  name = value
      if (src[idx] === "[") {
        isArray = false;
        idx++; // skip [
        idx = this._skipWhitespace(src, idx);

        let key;
        if (src[idx] === '"' || src[idx] === "'") {
          [key, idx] = this._parseString(src, idx);
        } else {
          [key, idx] = this._parseNumber(src, idx);
        }

        idx = this._skipWhitespace(src, idx);
        idx++; // skip ]
        idx = this._skipWhitespace(src, idx);
        idx++; // skip =
        idx = this._skipWhitespace(src, idx);

        const [value, newIdx] = this._parseValue(src, idx);
        idx = newIdx;

        if (typeof key === "number") {
          entries.push({ index: key, value });
        } else {
          stringKeys[key] = value;
        }
      } else if (/[A-Za-z_]/.test(src[idx])) {
        // Could be: name = value  OR  just a value reference
        const nameMatch = src.substring(idx).match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        if (nameMatch) {
          isArray = false;
          const key = nameMatch[1];
          idx += nameMatch[0].length;
          idx = this._skipWhitespace(src, idx);
          const [value, newIdx] = this._parseValue(src, idx);
          idx = newIdx;
          stringKeys[key] = value;
        } else {
          // Bare value in array
          const [value, newIdx] = this._parseValue(src, idx);
          idx = newIdx;
          entries.push({ index: arrayIndex++, value });
        }
      } else {
        // Bare value in array
        const [value, newIdx] = this._parseValue(src, idx);
        idx = newIdx;
        entries.push({ index: arrayIndex++, value });
      }

      idx = this._skipWhitespace(src, idx);
      if (src[idx] === ",") idx++; // skip comma separator
    }

    idx++; // skip closing }

    // Decide: return array or object
    if (Object.keys(stringKeys).length === 0 && entries.length > 0 && isArray) {
      // Pure numeric array
      const arr = [];
      entries.sort((a, b) => a.index - b.index);
      entries.forEach((e) => { arr[e.index - 1] = e.value; });
      return [arr, idx];
    }

    // Object (merge numeric entries as numbered keys)
    const obj = { ...stringKeys };
    entries.forEach((e) => { obj[e.index] = e.value; });
    return [obj, idx];
  }

  _parseString(src, idx) {
    const quote = src[idx];
    idx++; // skip opening quote
    let str = "";

    while (idx < src.length && src[idx] !== quote) {
      if (src[idx] === "\\") {
        idx++;
        switch (src[idx]) {
          case "n": str += "\n"; break;
          case "t": str += "\t"; break;
          case "r": str += "\r"; break;
          case "\\": str += "\\"; break;
          case "'": str += "'"; break;
          case '"': str += '"'; break;
          default: str += src[idx]; break;
        }
      } else {
        str += src[idx];
      }
      idx++;
    }

    idx++; // skip closing quote
    return [str, idx];
  }

  _parseNumber(src, idx) {
    const start = idx;
    if (src[idx] === "-") idx++;
    while (idx < src.length && ((src[idx] >= "0" && src[idx] <= "9") || src[idx] === ".")) {
      idx++;
    }
    const num = parseFloat(src.substring(start, idx));
    return [num, idx];
  }

  _skipWhitespace(src, idx) {
    while (idx < src.length && /\s/.test(src[idx])) idx++;
    return idx;
  }
}

module.exports = { LuaParser };
