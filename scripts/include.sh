echo "Setting up include demo"
{
    rm -rf demo
    mkdir demo
    cd demo
    git init meta
    git init x
    cd x
    touch foo
    git add foo
    git com -m "first x"
    cd ..
    git init y
    cd y
    touch bar
    git add bar
    git com -m "first y"
    cd ../meta
    git co -b my-branch
} &> /dev/null
