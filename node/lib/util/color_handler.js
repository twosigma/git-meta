const colorsSafe = require("colors/safe");

/**
 * This class is a wrapper around colors/safe that uses a color setting from
 * the git meta config to determine if colors should be enabled.
 */
class ColorHandler {
    /**
     * @param {Bool|"auto"|null} enableColor
     *
     * NOTE: enableColor should probably be set based on a value in
     * ConfigUtil.getConfigColorBool()
     */
    constructor(enableColor) {
        colorsSafe.enable();
        if(enableColor === "auto" || enableColor === undefined) {
            // Enable color if we're outputting to a terminal, otherwise disable
            // since we're piping the output.
            enableColor = process.stdout.isTTY === true;
        }

        this.enableColor = enableColor;

        let self = this;

        // add a passthrough function for each supported color
        ["blue", "cyan", "green", "grey", "magenta", "red", "yellow"].forEach(
            function(color) {
                self[color] = function(string) {
                    if(self.enableColor) {
                        return colorsSafe[color](string);
                    } else {
                        return string;
                    }
                };
            });
    }
}

exports.ColorHandler = ColorHandler;
