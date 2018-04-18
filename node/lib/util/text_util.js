/*
 * Copyright (c) 2018, Two Sigma Open Source
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * * Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * * Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * * Neither the name of git-meta nor the names of its
 *   contributors may be used to endorse or promote products derived from
 *   this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */
"use strict";

const assert = require("chai").assert;

/**
 * Compare two strings for Array.prototype.sort.  This is a useful
 * building-block for more complex comparison functions.
 */
exports.strcmp = function(a, b) {
   return (a < b) ? -1 : ((a > b) ? 1 : 0);
};

/**
 * Indent a single string
 * @param {String} str
 * @param {Integer} count number of spaces to indent (default 4)
 * @return {String} The string, indented
 */
exports.indent = function(str, count) {
    assert.isString(str);
    if (undefined !== count) {
        assert.isNumber(count);
        assert(count > 0);
    }
    else {
        count = 4;
    }
    return " ".repeat(count) + str;
};

/**
 * Convert a list of strings to a newline-delimited, indented string.
 *
 * @param {Array<String>} The strings
 * @param {Integer} count (default 4)
 * @return {String}
 */
exports.listToIndentedString = function(strings, count) {
    return strings.map(s => exports.indent(s, count)).join("\n");
};

/**
 * Pluralize a noun (if necessary).  This is kind of a hack:
 * it doesn't handle 'children', 'wolves', 'gees', or 'oxen'.
 *
 * @param {String} The noun
 * @param {Integer} the count -- if it's not 1, the noun will be pluralized.
 * @return {String}
 */
exports.pluralize = function(noun, count) {
    if (count === 1) {
        return noun;
    }
    if (noun.match("(?:s|sh|ch|z|x)$")) {
        return noun + "es";
    }
    if (noun.endsWith("y")) {
        return noun.substring(0, noun.length - 1) + "ies";
    }
    return noun + "s";
};
