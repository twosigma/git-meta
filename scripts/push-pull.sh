echo "Setting up 'slim push-pull' demo"
{
    rm -rf demo
    mkdir demo
    cd demo
    git init --bare meta-bare
    git init --bare x-bare
    git init --bare y-bare
    git clone meta-bare meta
    git clone x-bare x
    git clone y-bare y
    cd meta
    touch README.md
    git add README.md
    git com -m first
    git push origin master
    cd ../x
    touch foo
    git add foo
    git com -m "first x"
    git push origin master
    cd ../y
    touch bar
    git add bar
    git com -m "first y"
    git push origin master
    cd ../meta
    sl include ../x-bare x
    sl include ../y-bare y
    sl commit -m "added subs"
    sl push
    cd ..
    sl clone meta-bare other-meta
    cd other-meta
    sl open x
    cd x
    touch moo
    git add moo
    cd ..
    sl commit -m "moooo"
    sl push
    cd ..
    cd meta
    cd x
    echo aaa >> foo
} &> /dev/null
