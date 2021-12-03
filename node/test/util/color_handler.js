const assert       = require("chai").assert;
const ColorHandler = require("../../lib/util/color_handler").ColorHandler;

const realProcess = process;
describe("ColorHandler", function() {
    describe("colors", function() {
        describe("enableColor = 'auto'", function() {
            afterEach(function() {
                // this test futzes around with the process global so
                // make sure it is properly reset after each test.
                global.process = realProcess;
            });
            it("enables color when in a TTY", function() {
                global.process = {stdout: {isTTY: true}};
                const colors = new ColorHandler("auto");
                assert.isTrue(colors.enableColor);
            });

            it("disables color when not in a TTY", function() {
                global.process = {stdout: {isTTY: false}};
                const colors = new ColorHandler("auto");
                assert.isFalse(colors.enableColor);
                assert.equal("test", colors.blue("test"));
            });

            it("adds colors if enableColor", function() {
                const colors = new ColorHandler();
                colors.enableColor = true;
                assert.equal("\u001b[34mtest\u001b[39m", colors.blue("test"));
            });

            it("passes through string if !enableColor", function() {
                const colors = new ColorHandler();
                colors.enableColor = false;
                assert.equal("test", colors.blue("test"));
            });
        });
    });
});
