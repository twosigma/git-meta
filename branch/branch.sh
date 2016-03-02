echo "Setting up 'slim branch' demo"
{
    rm -rf branch-demo
    mkdir branch-demo
    cd branch-demo
    sl init meta
    git init x
    cd x
    touch foo
    git add foo
    git com -m first
    cd ..
    git init y
    cd y
    touch foo
    git add foo
    git com -m first
    cd ..
    cd meta
    sl include ../x x
    sl include ../y y
    sl commit -m "added subs"
} &> /dev/null
