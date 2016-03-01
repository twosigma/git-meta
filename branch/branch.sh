echo "Setting up for 'slim branch' demo"
{
    rm -rf branch-demo
    mkdir branch-demo
    cd branch-demo
    git init --bare base-bare
    git init --bare x-bare
    git clone x-bare x1
    cd x1
    touch foo
    git add foo
    git com -m "first foo"
    git push origin master
    cd ..
    git clone base-bare base1
    cd base1
    sl include ../x-bare x
    git com -m "added x"
    git push origin master
    cd ..
    git clone base-bare base2
    cd base2
    git submodule init x
    git submodule update x
    cd x
    git co  master
    echo foobar >> foobar
    git add foobar
    git com -m "foo bar added"
    git push origin master
    cd ..
    git add x
    git com -m "foo bar added"
    git push origin master
    cd ../base1
    cd x
    echo baaaaa >> foo
    git add foo
    git com -m "even more foo"
    cd ..
    git add x
    git com -m "even more foo"
    cd x
    echo baasdfasfd >> foo
    git add foo
    git com -m "once more into the foo"
    cd ..
    git add x
    git com -m "once more into the foo"
    git fetch
} &> /dev/null

cd ../base2/x
echo ">>> Other X Log"
git log --oneline
cd ../../base1
cd x
echo ">>>> X log"
git log --oneline
cd ..
echo ">>>> origin log"
git log --oneline origin/master
echo ">>>> local meta log"
git log --oneline
sl pull
